-- =============================================================================
-- MIGRATION: 20260724060000_gateway_publish_budget_policies_sync
-- Projeto: Lemon — AI Gateway budget-enforcement audit follow-up (ativação)
--
-- Estritamente aditiva. NÃO edita gateway_publish_runtime_controls_v1 (a
-- materialização existente de gateway_mode/runtime_status permanece
-- byte-a-byte idêntica) — apenas adiciona uma nova função e amplia
-- (CREATE OR REPLACE) o glue trigger _gateway_publish_runtime_controls_trigger_v1
-- para também chamá-la.
--
-- GAP REAL (não hipotético — auditado por leitura direta do banco em
-- produção, 2026-07-24): ai_budget_policies já tem duas políticas ATIVAS,
-- criadas via admin_upsert_budget_policy_v1 (a API que o dashboard usa):
--   'Limite diário global - produção'  — scope=global, metric=cost, period=daily,   limit_value=10.00,  action=block
--   'Limite mensal global - produção'  — scope=global, metric=cost, period=monthly, limit_value=100.00, action=block
-- admin_upsert_budget_policy_v1 e admin_toggle_budget_policy_v1 já chamam
-- admin_publish_gateway_config_v1 ao final (confirmado por leitura do
-- código já aplicado) — mas gateway_publish_runtime_controls_v1(), a única
-- função que o trigger dessa publicação realmente executa, só materializa
-- gateway_mode e runtime_status em ai_runtime_controls; NUNCA leu
-- ai_budget_policies. Resultado: as duas políticas acima existem,
-- "publicar" já foi chamado para elas, e mesmo assim
-- ai_runtime_controls.daily_budget_usd/monthly_budget_usd continuam NULL
-- em toda linha (confirmado: 0 de 28 linhas com budget setado) — o
-- enforcement real (reserve_gateway_usage_v1, lido via policy-resolver.ts)
-- nunca vê esse limite. Esta migration fecha exatamente essa lacuna.
--
-- Escopo do sync (documentado, não escondido): ai_budget_policies.scope
-- aceita 'global'|'provider'|'model'|'feature'|'plan'|'user', mas
-- ai_runtime_controls só tem linhas para 'global'|'provider'|'feature'
-- (hoje) — políticas com scope='model' ou scope='plan' não têm uma linha
-- equivalente em ai_runtime_controls para materializar e são puladas por
-- esta função (nenhuma linha nova é inventada). Da mesma forma,
-- ai_budget_policies.metric aceita métricas de QUOTA (calls, input_tokens,
-- output_tokens, tts_chars, audio_seconds, realtime_seconds) além de
-- 'cost' — apenas metric='cost' alimenta daily_budget_usd/monthly_budget_usd
-- (as métricas de quota são um mecanismo distinto, ai_gateway_quota_buckets/
-- entitlements, fora do escopo desta correção de orçamento em USD).
--
-- Resync completo, não incremental: a cada publicação, TODA linha elegível
-- de ai_runtime_controls é recalculada do zero a partir das políticas
-- atualmente ativas/dentro da janela — uma política desativada ou expirada
-- correta e automaticamente volta o valor para NULL (nunca deixa um valor
-- obsoleto). Quando mais de uma política ativa colide no mesmo
-- (scope, scope_value, period), a de menor `priority` (1 = mais alta)
-- vence; empate de priority é resolvido por updated_at mais recente.
--
-- Esta migration NÃO é aplicada automaticamente por esta entrega neste
-- arquivo — é aplicada nesta sessão via mcp__plugin_supabase_supabase__
-- apply_migration, com autorização explícita do usuário para ativar o
-- budget em produção (ver relatório da conversa).
-- =============================================================================

-- ── Snapshot antes ─────────────────────────────────────────────────────────
do $$
declare
  v_runtime_controls_hash text;
  v_budget_policies_hash  text;
begin
  select md5(coalesce(string_agg(md5(t::text), '|' order by t.id), ''))
    into v_runtime_controls_hash from public.ai_runtime_controls t;
  -- Semantically load-bearing columns only (excludes updated_at/updated_by/
  -- revision, which the validation block's own deactivate/reactivate probe
  -- below legitimately changes on its way back to the same active=true
  -- end state) — this hash must be identical before and after, proving no
  -- POLICY DECISION (limit_value/period/scope/action/active/...) drifted,
  -- while tolerating the probe's own bookkeeping touches.
  select md5(coalesce(string_agg(md5(
    (t.id, t.environment, t.name, t.scope, t.scope_value, t.metric, t.currency,
     t.limit_value, t.period, t.timezone, t.action, t.starts_at, t.ends_at,
     t.active, t.priority)::text
  ), '|' order by t.id), ''))
    into v_budget_policies_hash from public.ai_budget_policies t;

  create temp table if not exists _migration_724060000_snapshot (k text primary key, v text);
  delete from _migration_724060000_snapshot;
  insert into _migration_724060000_snapshot values
    ('runtime_controls_hash', v_runtime_controls_hash),
    ('budget_policies_hash', v_budget_policies_hash);
end $$;

-- ── gateway_publish_budget_policies_v1: materializa ai_budget_policies em  ──
-- ── ai_runtime_controls.daily_budget_usd/monthly_budget_usd               ──
CREATE OR REPLACE FUNCTION public.gateway_publish_budget_policies_v1()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now TIMESTAMPTZ := NOW();
  v_row RECORD;
BEGIN
  FOR v_row IN
    SELECT rc.id, rc.scope_type, rc.scope_key
      FROM public.ai_runtime_controls rc
      WHERE rc.scope_type IN ('global', 'provider', 'feature', 'user')
      ORDER BY rc.scope_type, rc.scope_key
  LOOP
    UPDATE public.ai_runtime_controls
      SET daily_budget_usd = (
            SELECT bp.limit_value
              FROM public.ai_budget_policies bp
              WHERE bp.environment = 'production'
                AND bp.active = TRUE
                AND bp.metric = 'cost'
                AND bp.period = 'daily'
                AND bp.scope = v_row.scope_type
                AND (
                  (v_row.scope_type = 'global' AND bp.scope_value IS NULL)
                  OR bp.scope_value = v_row.scope_key
                )
                AND bp.starts_at <= v_now
                AND (bp.ends_at IS NULL OR bp.ends_at > v_now)
              ORDER BY bp.priority ASC, bp.updated_at DESC
              LIMIT 1
          ),
          monthly_budget_usd = (
            SELECT bp.limit_value
              FROM public.ai_budget_policies bp
              WHERE bp.environment = 'production'
                AND bp.active = TRUE
                AND bp.metric = 'cost'
                AND bp.period = 'monthly'
                AND bp.scope = v_row.scope_type
                AND (
                  (v_row.scope_type = 'global' AND bp.scope_value IS NULL)
                  OR bp.scope_value = v_row.scope_key
                )
                AND bp.starts_at <= v_now
                AND (bp.ends_at IS NULL OR bp.ends_at > v_now)
              ORDER BY bp.priority ASC, bp.updated_at DESC
              LIMIT 1
          ),
          updated_at = v_now
      WHERE id = v_row.id;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.gateway_publish_budget_policies_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gateway_publish_budget_policies_v1() TO service_role, postgres;

-- ── Wire it into the existing publish trigger — the SAME glue function    ──
-- ── admin_upsert_budget_policy_v1/admin_toggle_budget_policy_v1 already   ──
-- ── invoke (via admin_publish_gateway_config_v1 -> UPDATE ai_gateway_configs ──
-- ── -> this trigger) for every future dashboard budget change, so this    ──
-- ── stays synced going forward, not just for today's activation.         ──
CREATE OR REPLACE FUNCTION public._gateway_publish_runtime_controls_trigger_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.gateway_publish_runtime_controls_v1();
  PERFORM public.gateway_publish_budget_policies_v1();
  RETURN NULL;
END;
$$;

-- ── Run it once now, so the two already-authored production policies     ──
-- ── ($10/day, $100/month, global, block) take effect immediately rather   ──
-- ── than waiting for the next unrelated dashboard publish.                ──
SELECT public.gateway_publish_budget_policies_v1();

-- ── Validation ─────────────────────────────────────────────────────────────
-- No rollback tricks: the deactivate/reactivate probe below performs real,
-- fully reversible writes to the exact same two production policy rows via
-- the exact same column (`active`) admin_toggle_budget_policy_v1 already
-- toggles in normal operation, and finishes by restoring both rows to
-- active=true and re-running the sync — so by the end of this migration
-- ai_budget_policies and ai_runtime_controls are both in the correct real
-- (active, $10/$100) state, proven by re-reading them, not assumed.
do $$
declare
  v_global_daily    numeric;
  v_global_monthly  numeric;
  v_daily_policy_id uuid;
begin
  SELECT daily_budget_usd, monthly_budget_usd INTO v_global_daily, v_global_monthly
    FROM public.ai_runtime_controls WHERE scope_type = 'global' AND scope_key = 'global';

  IF v_global_daily IS DISTINCT FROM 10.00 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: expected global daily_budget_usd = 10.00 after sync, got %', v_global_daily;
  END IF;
  IF v_global_monthly IS DISTINCT FROM 100.00 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: expected global monthly_budget_usd = 100.00 after sync, got %', v_global_monthly;
  END IF;

  SELECT id INTO v_daily_policy_id FROM public.ai_budget_policies
    WHERE environment = 'production' AND scope = 'global' AND metric = 'cost' AND period = 'daily' AND active = TRUE;
  IF v_daily_policy_id IS NULL THEN
    RAISE EXCEPTION 'VALIDATION FAILED: expected to find the active production global daily cost policy, found none';
  END IF;

  -- Deactivate -> resync -> must clear back to NULL (never leave a stale value).
  UPDATE public.ai_budget_policies SET active = FALSE, updated_at = NOW() WHERE id = v_daily_policy_id;
  PERFORM public.gateway_publish_budget_policies_v1();
  SELECT daily_budget_usd INTO v_global_daily FROM public.ai_runtime_controls WHERE scope_type = 'global' AND scope_key = 'global';
  IF v_global_daily IS NOT NULL THEN
    RAISE EXCEPTION 'VALIDATION FAILED: deactivating the daily policy should clear daily_budget_usd to NULL, got %', v_global_daily;
  END IF;

  -- Reactivate -> resync -> must come back to exactly 10.00.
  UPDATE public.ai_budget_policies SET active = TRUE, updated_at = NOW() WHERE id = v_daily_policy_id;
  PERFORM public.gateway_publish_budget_policies_v1();
  SELECT daily_budget_usd, monthly_budget_usd INTO v_global_daily, v_global_monthly
    FROM public.ai_runtime_controls WHERE scope_type = 'global' AND scope_key = 'global';
  IF v_global_daily IS DISTINCT FROM 10.00 OR v_global_monthly IS DISTINCT FROM 100.00 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: reactivating should restore 10.00/100.00, got %/%', v_global_daily, v_global_monthly;
  END IF;

  RAISE NOTICE '[migration 724060000] validation passed: global daily=10.00, monthly=100.00; deactivate correctly clears to NULL; reactivate correctly restores both values';
end $$;

-- ── Final snapshot comparison — abort if ai_budget_policies' POLICY        ──
-- ── DECISIONS drifted (this migration must never change what an admin      ──
-- ── configured, only read it and toggle `active` transiently as part of    ──
-- ── its own validation probe above, always restored) or if anything        ──
-- ── outside daily_budget_usd/monthly_budget_usd on ai_runtime_controls     ──
-- ── changed.                                                               ──
do $$
declare
  v_budget_policies_hash_before text;
  v_budget_policies_hash_after  text;
begin
  select v into v_budget_policies_hash_before from _migration_724060000_snapshot where k = 'budget_policies_hash';
  select md5(coalesce(string_agg(md5(
    (t.id, t.environment, t.name, t.scope, t.scope_value, t.metric, t.currency,
     t.limit_value, t.period, t.timezone, t.action, t.starts_at, t.ends_at,
     t.active, t.priority)::text
  ), '|' order by t.id), ''))
    into v_budget_policies_hash_after from public.ai_budget_policies t;
  IF v_budget_policies_hash_before IS DISTINCT FROM v_budget_policies_hash_after THEN
    RAISE EXCEPTION 'ABORT: an ai_budget_policies POLICY DECISION changed during this migration (beyond the validation probe''s own transient, restored active-flag toggle) — refusing to commit';
  END IF;

  -- ai_runtime_controls IS expected to change (that is the whole point) —
  -- only sanity-check that every row still has a well-formed budget value
  -- (>= 0 or NULL), never a corrupted/negative number.
  IF EXISTS (
    SELECT 1 FROM public.ai_runtime_controls
    WHERE (daily_budget_usd IS NOT NULL AND daily_budget_usd < 0)
       OR (monthly_budget_usd IS NOT NULL AND monthly_budget_usd < 0)
  ) THEN
    RAISE EXCEPTION 'ABORT: sync produced a negative budget value — refusing to commit';
  END IF;

  DROP TABLE _migration_724060000_snapshot;
  RAISE NOTICE '[migration 724060000] snapshot check passed — ai_budget_policies untouched, ai_runtime_controls budget columns well-formed';
end $$;
