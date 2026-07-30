-- =============================================================================
-- MIGRATION: 20260727224100_publish_plan_version_trial_total_capability
-- Projeto: Lemon
--
-- Histórico de renomeações (Etapa 2A — revisão de versionamento), nenhuma
-- delas aplicada em nenhum ambiente; conteúdo idêntico em todas:
--   20260727010000 → uma migration irmã desta (20260727000000) colidia com
--     uma migration já aplicada pelo ingles-dashboad em lemon-homolog
--     (versão real registrada em supabase_migrations.schema_migrations:
--     20260727223126).
--   20260728010000 → data artificialmente no futuro (hoje é 27/07/2026) —
--     corrigida para 20260727224100, mesma data de hoje, posterior à maior
--     versão remota conhecida.
--
-- Etapa 2A — Suporte real ao limite total de Conversação no Trial.
--
-- publish_plan_version() ainda exige incondicionalmente o par
-- (conversation.realtime.seconds.monthly, conversation.realtime.seconds.
-- monthly.unlimited) para considerar a Conversação completa. O plano interno
-- 'trial' (dashboard) usa em vez disso um total consumível durante toda a
-- atribuição (conversation.realtime.seconds.trial_total /
-- .trial_total.unlimited), então a publicação do draft do trial falha na
-- validação de completude mesmo com a configuração correta.
--
-- Esta migration substitui a função (mesma assinatura, mesmo contrato de
-- retorno, SECURITY DEFINER, search_path, autorização, concorrência
-- otimista, revisão, config_hash, retirada da versão anterior, auditoria e
-- todas as demais validações preservadas) para que, EXCLUSIVAMENTE quando
-- plans.code = 'trial', o par trial_total/trial_total.unlimited satisfaça a
-- completude da Conversação no lugar do par monthly/monthly.unlimited.
-- Nenhum outro critério é usado (não is_visible_to_users, não preço,
-- não is_default, não origem da atribuição) — apenas plans.code.
--
-- Todos os demais planos (incluindo planos invisíveis, internos ou com
-- preço zero que não sejam 'trial') continuam exigindo exatamente o par
-- monthly/monthly.unlimited, sem nenhum enfraquecimento.
--
-- Idempotente: CREATE OR REPLACE FUNCTION. Não altera migrations históricas.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.publish_plan_version(p_plan_id uuid, p_draft_version_id uuid, p_client_revision integer, p_publication_notes text, p_change_summary text, p_config_hash text, p_actor_user_id uuid, p_activate_plan boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_draft public.plan_versions%rowtype;
  v_published public.plan_versions%rowtype;
  v_now timestamptz := now();
  v_retired_id uuid := null;
  v_missing_capabilities text[];
  v_plan_code text;
begin
  if not exists (
    select 1 from public.admin_users
    where user_id = p_actor_user_id and status = 'active' and role in ('owner', 'admin')
  ) then
    return jsonb_build_object('success', false, 'error', 'UNAUTHORIZED');
  end if;

  select * into v_draft
  from public.plan_versions
  where id = p_draft_version_id and plan_id = p_plan_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'error', 'Rascunho não encontrado');
  end if;

  if v_draft.status <> 'draft' then
    return jsonb_build_object('success', false, 'error', 'Versão não está em rascunho');
  end if;

  if v_draft.revision <> p_client_revision then
    return jsonb_build_object(
      'success', false,
      'error', 'Conflito: outro administrador modificou este rascunho. Recarregue e tente novamente.',
      'conflict', true
    );
  end if;

  -- Resolvido a partir do próprio plano do rascunho (nunca do cliente) —
  -- único critério usado para decidir qual par de capabilities de tempo de
  -- Conversação satisfaz a completude (ver comentário acima).
  select code into v_plan_code from public.plans where id = p_plan_id;

  select array_agg(req.key order by req.key) into v_missing_capabilities
  from (values
    ('writing.enabled'), ('listening.enabled'), ('pronunciation.enabled'),
    ('conversation.enabled'), ('conversation.extra_purchase_enabled')
  ) as req(key)
  where not exists (
    select 1 from public.plan_capability_values pcv
    where pcv.plan_version_id = p_draft_version_id and pcv.capability_key = req.key
  );

  select v_missing_capabilities || coalesce(array_agg(pair.base_key order by pair.base_key), '{}')
  into v_missing_capabilities
  from (
    values
      ('writing.theme_generations_per_day', 'writing.theme_generations_per_day.unlimited'),
      ('writing.max_characters_per_text', 'writing.max_characters_per_text.unlimited'),
      ('writing.reviews_per_day', 'writing.reviews_per_day.unlimited'),
      ('listening.stories_per_day', 'listening.stories_per_day.unlimited'),
      ('pronunciation.evaluations_per_day', 'pronunciation.evaluations_per_day.unlimited'),
      ('pronunciation.max_recording_seconds', 'pronunciation.max_recording_seconds.unlimited'),
      ('conversation.max_recording_seconds', 'conversation.max_recording_seconds.unlimited'),
      (
        case when v_plan_code = 'trial'
          then 'conversation.realtime.seconds.trial_total'
          else 'conversation.realtime.seconds.monthly'
        end,
        case when v_plan_code = 'trial'
          then 'conversation.realtime.seconds.trial_total.unlimited'
          else 'conversation.realtime.seconds.monthly.unlimited'
        end
      )
  ) as pair(base_key, unlimited_key)
  where not exists (
    select 1 from public.plan_capability_values pcv
    where pcv.plan_version_id = p_draft_version_id
      and (
        pcv.capability_key = pair.base_key
        or (pcv.capability_key = pair.unlimited_key and pcv.value = 'true'::jsonb)
      )
  );

  if v_missing_capabilities is not null and array_length(v_missing_capabilities, 1) > 0 then
    return jsonb_build_object(
      'success', false,
      'error', 'Configuração incompleta: faltam capabilities obrigatórias para publicar esta versão.',
      'missing_capabilities', to_jsonb(v_missing_capabilities)
    );
  end if;

  select * into v_published
  from public.plan_versions
  where plan_id = p_plan_id
    and status = 'published'
    and effective_to is null
  for update;

  if found then
    update public.plan_versions
    set status = 'retired',
        effective_to = v_now
    where id = v_published.id;
    v_retired_id := v_published.id;
  end if;

  update public.plan_versions
  set
    status = 'published',
    effective_from = v_now,
    effective_to = null,
    published_at = v_now,
    published_by = p_actor_user_id,
    config_hash = p_config_hash,
    publication_notes = p_publication_notes,
    change_summary = p_change_summary
  where id = p_draft_version_id;

  if p_activate_plan then
    update public.plans
    set status = 'active',
        updated_at = v_now
    where id = p_plan_id and status = 'draft';
  end if;

  return jsonb_build_object(
    'success', true,
    'retired_version_id', v_retired_id,
    'new_version_id', p_draft_version_id
  );
end;
$function$;
