-- =============================================================================
-- MIGRATION: 20260903120000_admin_hard_delete_user_fold_usage_daily
-- Projeto: Orodim
--
-- Aplicada automaticamente por .github/workflows/homologation.yml
-- (supabase db push) após push em develop, e por deploy-production.yml em main.
-- NÃO aplicar manualmente no SQL Editor nem via MCP apply_migration — isso
-- desalinha o histórico de `supabase migration list` / schema_migrations.
--
-- OBJETIVO: corrigir a falha RECORRENTE da exclusão definitiva de usuário em que
-- os dados pessoais são removidos, mas a etapa final `auth.admin.deleteUser`
-- falha com um erro serializado vazio ("… a exclusão no Supabase Auth falhou
-- ({})"). A causa-raiz NÃO é uma FK RESTRICT pendente: é a tabela analítica
-- public.usage_daily.
--
-- CAUSA-RAIZ (confirmada em produção):
--   * usage_daily.user_id tem FK ON DELETE SET NULL (linhas ficam anonimizadas,
--     por decisão de retenção — ver 20260820122000_admin_hard_delete_user.sql).
--   * PORÉM o índice único uq_usage_daily_composite é
--       (usage_date, COALESCE(user_id::text,'00000000-…-000000000000'),
--        actor_type, feature_key, provider, COALESCE(model,''))
--     ou seja, TODAS as linhas anonimizadas colapsam num ÚNICO balde por tupla.
--   * Ao apagar auth.users, o SET NULL joga as linhas DESTE usuário nesse balde
--     e colide (SQLSTATE 23505) com as linhas que uma exclusão ANTERIOR já
--     deixou anonimizadas na mesma tupla → o DELETE em auth.users aborta inteiro.
--   * A primeira exclusão de sempre passa (cria o agregado); da segunda em diante
--     falha — exatamente o padrão observado.
--
-- CORREÇÃO: o RPC de hard-delete passa a NEUTRALIZAR usage_daily ANTES de o API
-- chamar auth.admin.deleteUser, com a semântica "fold-then-anonymize":
--   (a) soma os contadores das linhas do usuário no agregado anonimizado
--       (user_id IS NULL) já existente da mesma tupla — preservando os totais
--       analíticos, fiel à decisão de retenção;
--   (b) apaga as linhas de origem que foram somadas;
--   (c) anonimiza (user_id := NULL) qualquer linha remanescente cuja tupla ainda
--       não tenha agregado (aí não há colisão possível).
-- Depois disso não sobra nenhuma linha com user_id = p_user_id, então o SET NULL
-- da FK vira no-op e o auth.admin.deleteUser conclui. Idempotente.
--
-- ESCOPO: apenas CREATE OR REPLACE da função public.admin_hard_delete_user_v1.
-- O corpo é idêntico ao de 20260820122000 (mesma lista de tabelas, mesmas
-- travas de segurança), acrescido do passo usage_daily e de dois contadores
-- informativos no JSON de retorno. Nenhuma outra estrutura é tocada.
-- =============================================================================

create or replace function public.admin_hard_delete_user_v1(
  p_user_id  uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  -- child → parent order. Every table here is PERSONAL (deleting a row never
  -- removes shared/global content). Non-standard user columns are noted.
  v_targets text[][] := array[
    -- listening (per-user)
    ['user_listening_attempts','user_id'],
    ['user_listening_block_sessions','user_id'],
    ['user_listening_results','user_id'],
    ['user_listening_generation_sessions','user_id'],
    ['user_listening_progress','user_id'],
    ['user_listening_assignments','user_id'],
    ['user_listening_shared_progress','user_id'],
    -- review ("revisar meus erros")
    ['review_item_attempts','user_id'],
    ['review_attempts','user_id'],
    ['review_group_items','user_id'],
    ['review_groups','user_id'],
    ['review_schedule_history','user_id'],
    -- writing (delete referrers of english_reviews before it)
    ['writing_rewrite_evidence_candidates','user_id'],
    ['writing_rewrite_evaluations','user_id'],
    ['writing_rewrite_attempts','user_id'],
    ['writing_review_reservations','user_id'],
    ['writing_entries','user_id'],
    ['generated_themes','user_id'],
    -- pronunciation
    ['pronunciation_word_attempts','user_id'],
    ['pronunciation_assessments','user_id'],
    ['pronunciation_training_sessions','user_id'],
    -- conversation
    ['conversation_session_authorizations','user_id'],
    ['conversation_sessions','user_id'],
    ['user_conversation_credits','user_id'],
    -- writing core (parents; children above already gone / cascade)
    ['english_reviews','user_id'],
    ['english_learning_memory','user_id'],
    -- placement (children cascade off attempt_id)
    ['placement_attempts','user_id'],
    -- curriculum / progress / preferences
    ['user_subtopic_completion','user_id'],
    ['user_subtopic_modality_progress','user_id'],
    ['user_curriculum_progress','user_id'],
    ['user_curriculum_preferences','user_id'],
    ['user_learning_paths','user_id'],
    ['learner_skill_profiles','user_id'],
    -- settings / calendar
    ['learning_day_overrides','user_id'],
    ['user_learning_settings','user_id'],
    ['ai_conversation_preferences','user_id'],
    -- per-user AI scoping
    ['ai_gateway_quota_buckets','subject_id'],
    -- entitlements / plan / access
    ['user_capability_overrides','user_id'],
    ['user_plan_assignments','user_id'],
    ['user_access_controls','user_id'],
    -- shared-content link (shared item itself is preserved)
    ['user_shared_content_usage','user_id'],
    -- user-id-scoped blocks (deleted per retention decision)
    ['user_billing_blocks','user_id'],
    ['user_account_deactivations','user_id']
  ];
  v_table text;
  v_col   text;
  v_count bigint;
  v_total bigint := 0;
  v_counts jsonb := '{}'::jsonb;
  v_actor_role text;
  v_usage_daily_folded bigint := 0;      -- rows summed into an existing NULL aggregate
  v_usage_daily_anonymized bigint := 0;  -- leftover rows re-pointed to NULL (no aggregate yet)
begin
  if p_user_id is null then
    raise exception 'HARD_DELETE_INVALID_USER: user_id is null' using errcode = '22004';
  end if;

  -- Actor must be an active owner (belt-and-suspenders over the API gate).
  select role into v_actor_role
  from public.admin_users
  where user_id = p_actor_id and status = 'active';
  if v_actor_role is null or v_actor_role <> 'owner' then
    raise exception 'HARD_DELETE_FORBIDDEN: actor is not an active owner' using errcode = '42501';
  end if;

  -- Never hard-delete an admin account through this tool (also avoids the
  -- NO ACTION staff-column FKs that would block the auth deletion downstream).
  if exists (select 1 from public.admin_users where user_id = p_user_id) then
    raise exception 'HARD_DELETE_ADMIN_ACCOUNT: refusing to hard-delete an admin account' using errcode = '42501';
  end if;

  -- Delete each target table by its user column, tolerating tables that may not
  -- exist in a given environment (homolog drift): guard with to_regclass.
  for i in 1 .. array_length(v_targets, 1) loop
    v_table := v_targets[i][1];
    v_col   := v_targets[i][2];
    if to_regclass('public.' || v_table) is null then
      continue;
    end if;
    execute format('delete from public.%I where %I = $1', v_table, v_col) using p_user_id;
    get diagnostics v_count = row_count;
    if v_count > 0 then
      v_counts := v_counts || jsonb_build_object(v_table, v_count);
      v_total := v_total + v_count;
    end if;
  end loop;

  -- ── usage_daily: fold-then-anonymize (see migration header for the why) ─────
  -- Neutralise usage_daily BEFORE the API's auth.admin.deleteUser so its FK
  -- ON DELETE SET NULL cannot collide with uq_usage_daily_composite. usage_daily
  -- stays out of v_targets on purpose: retention keeps the anonymized aggregate.
  if to_regclass('public.usage_daily') is not null then
    -- (a) sum this user's daily counters into the existing NULL aggregate row
    --     for the same composite tuple.
    with src as (
      select usage_date, actor_type, feature_key, provider, model,
             sum(total_requests) tr, sum(successful_requests) sr, sum(failed_requests) fr,
             sum(blocked_requests) br, sum(cache_hits) ch, sum(unpriced_events) ue,
             sum(estimated_cost_usd) ec, sum(calculated_cost_usd) cc, sum(reconciled_cost_usd) rc,
             sum(distinct_logical_requests) dlr, sum(coalesce(total_latency_ms,0)) tl,
             max(last_event_at) le
      from public.usage_daily
      where user_id = p_user_id
      group by usage_date, actor_type, feature_key, provider, model
    )
    update public.usage_daily agg
    set total_requests            = agg.total_requests + src.tr,
        successful_requests       = agg.successful_requests + src.sr,
        failed_requests           = agg.failed_requests + src.fr,
        blocked_requests          = agg.blocked_requests + src.br,
        cache_hits                = agg.cache_hits + src.ch,
        unpriced_events           = agg.unpriced_events + src.ue,
        estimated_cost_usd        = agg.estimated_cost_usd + src.ec,
        calculated_cost_usd       = agg.calculated_cost_usd + src.cc,
        reconciled_cost_usd       = agg.reconciled_cost_usd + src.rc,
        distinct_logical_requests = agg.distinct_logical_requests + src.dlr,
        total_latency_ms          = coalesce(agg.total_latency_ms,0) + src.tl,
        last_event_at             = greatest(agg.last_event_at, src.le),
        updated_at                = now()
    from src
    where agg.user_id is null
      and agg.usage_date  = src.usage_date
      and agg.actor_type  = src.actor_type
      and agg.feature_key = src.feature_key
      and agg.provider    = src.provider
      and coalesce(agg.model,'') = coalesce(src.model,'');

    -- (b) drop the user's rows that were folded into an existing NULL aggregate.
    delete from public.usage_daily m
    where m.user_id = p_user_id
      and exists (
        select 1 from public.usage_daily a
        where a.user_id is null
          and a.usage_date=m.usage_date and a.actor_type=m.actor_type
          and a.feature_key=m.feature_key and a.provider=m.provider
          and coalesce(a.model,'')=coalesce(m.model,'')
      );
    get diagnostics v_usage_daily_folded = row_count;

    -- (c) anonymize any leftover tuple that had no aggregate yet (no collision).
    update public.usage_daily
    set user_id = null, updated_at = now()
    where user_id = p_user_id;
    get diagnostics v_usage_daily_anonymized = row_count;
  end if;

  return jsonb_build_object(
    'user_id', p_user_id,
    'total_rows_deleted', v_total,
    'deleted_counts', v_counts,
    'usage_daily_folded', v_usage_daily_folded,          -- summed into an existing anon aggregate then dropped
    'usage_daily_anonymized', v_usage_daily_anonymized,  -- re-pointed to NULL (first anon for that tuple)
    'auth_user_deleted', false,   -- the API performs auth.admin.deleteUser afterwards
    'executed_at', now()
  );
end;
$$;

grant execute on function public.admin_hard_delete_user_v1(uuid, uuid) to service_role;
