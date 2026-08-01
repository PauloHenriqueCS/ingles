-- =============================================================================
-- MIGRATION: 20260718230000_publish_plan_version_requires_complete_capabilities
-- Projeto: Lemon
--
-- Reforça publish_plan_version() (função de banco compartilhada, chamada
-- pelo dashboard administrativo) para recusar a publicação de uma versão de
-- plano que esteja faltando qualquer uma das capabilities obrigatórias das
-- 4 features do app do aluno (writing, listening, pronunciation,
-- conversation). Isto NÃO altera nenhuma tela/código do dashboard — apenas
-- a função de banco que ele já chama, mantendo a MESMA assinatura e
-- contrato de retorno (jsonb com success/error), só adicionando uma nova
-- causa possível de success=false.
--
-- Regra de "obrigatória" (espelha exatamente api/_entitlements/
-- resolve-capability-values.ts):
--   - capabilities booleanas simples (X.enabled, conversation.
--     extra_purchase_enabled): precisam ter uma linha configurada (true OU
--     false já conta — o que falta é a linha, não um valor específico).
--   - pares numéricos (base + base.unlimited): precisam ter a linha base
--     OU a linha ".unlimited" com valor true. NUNCA exige um número
--     quando o ".unlimited" correspondente já é true.
--
-- Não bloqueia publicação alguma retroativamente — versões já publicadas
-- continuam publicadas; a validação só entra em vigor no próximo publish.
-- =============================================================================

create or replace function public.publish_plan_version(
  p_plan_id uuid,
  p_draft_version_id uuid,
  p_client_revision integer,
  p_publication_notes text,
  p_change_summary text,
  p_config_hash text,
  p_actor_user_id uuid,
  p_activate_plan boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_draft public.plan_versions%rowtype;
  v_published public.plan_versions%rowtype;
  v_now timestamptz := now();
  v_retired_id uuid := null;
  v_missing_capabilities text[];
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

  -- Capabilities obrigatórias: precisam de uma linha própria (qualquer
  -- valor booleano válido conta como configurado — o que falta é a linha).
  select array_agg(req.key order by req.key) into v_missing_capabilities
  from (values
    ('writing.enabled'), ('listening.enabled'), ('pronunciation.enabled'),
    ('conversation.enabled'), ('conversation.extra_purchase_enabled')
  ) as req(key)
  where not exists (
    select 1 from public.plan_capability_values pcv
    where pcv.plan_version_id = p_draft_version_id and pcv.capability_key = req.key
  );

  -- Pares numéricos: a base OU o ".unlimited"=true satisfazem o par —
  -- nunca exige um número quando unlimited já é true.
  select v_missing_capabilities || coalesce(array_agg(pair.base_key order by pair.base_key), '{}')
  into v_missing_capabilities
  from (values
    ('writing.theme_generations_per_day', 'writing.theme_generations_per_day.unlimited'),
    ('writing.max_characters_per_text', 'writing.max_characters_per_text.unlimited'),
    ('writing.reviews_per_day', 'writing.reviews_per_day.unlimited'),
    ('listening.stories_per_day', 'listening.stories_per_day.unlimited'),
    ('pronunciation.evaluations_per_day', 'pronunciation.evaluations_per_day.unlimited'),
    ('pronunciation.max_recording_seconds', 'pronunciation.max_recording_seconds.unlimited'),
    ('conversation.realtime.seconds.monthly', 'conversation.realtime.seconds.monthly.unlimited'),
    ('conversation.max_recording_seconds', 'conversation.max_recording_seconds.unlimited')
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
