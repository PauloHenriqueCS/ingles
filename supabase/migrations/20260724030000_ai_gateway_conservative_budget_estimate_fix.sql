-- =============================================================================
-- MIGRATION: 20260724030000_ai_gateway_conservative_budget_estimate_fix
-- Projeto: Lemon — AI Gateway budget-enforcement audit follow-up
--
-- Estritamente aditiva. NÃO edita nenhuma das migrations já aplicadas
-- (20260718000000/010000/020000/030000) — apenas substitui (CREATE OR
-- REPLACE) a definição atual de reserve_gateway_usage_v1 por uma versão
-- corrigida, preservando assinatura, tipos de retorno, ordem de locks,
-- idempotência, SECURITY DEFINER, search_path, dono e permissões.
--
-- Esta migration NÃO é aplicada remotamente por este processo — apenas
-- criada e validada localmente. Confirmado por leitura direta de
-- pg_proc/ai_runtime_controls no projeto ao vivo, em 2026-07-24: gateway_mode
-- já é 'enforce' para praticamente todas as linhas reais de
-- ai_runtime_controls (feature/provider/global) — este pipeline está ativo
-- em produção, não é mais um caminho hipotético só exercitado por testes.
-- Nenhum daily_budget_usd/monthly_budget_usd está configurado em nenhum
-- escopo hoje (confirmado pela mesma leitura), então o bug corrigido aqui é
-- LATENTE (nunca ainda observado em produção porque nenhum budget real foi
-- ligado) mas real: no instante em que um administrador configurar o
-- primeiro budget, este bug já teria permitido que qualquer chamada
-- individual estourasse esse limite sem ser bloqueada. Este fix fecha a
-- lacuna ANTES disso acontecer.
--
-- BUG REAL (não hipotético — lido diretamente do código já aplicado):
--   Nenhum chamador de executeAiGatewayCall jamais popula
--   context.estimatedCostUsd (auditado em api/_ai-gateway/enforcement.ts e
--   em toda chamada real a executeAiGatewayCall neste repositório). A
--   Fase 2 de reserve_gateway_usage_v1 lê:
--
--     IF COALESCE(p_estimated_cost_usd, 0) > GREATEST(v_available, 0) THEN
--
--   um p_estimated_cost_usd NULL é silenciosamente tratado como "esta
--   chamada custa $0" — então uma ÚNICA chamada cujo próprio pior custo
--   razoavelmente possível já ultrapassaria o saldo restante NUNCA era
--   bloqueada por essa checagem; apenas uma chamada LATER, não relacionada,
--   depois que o gasto committed acumulado sozinho já excedesse o limite,
--   conseguia disparar o gate ("bloqueia na próxima chamada" — não
--   aceitável).
--
-- CORREÇÃO EM DUAS CAMADAS (a camada SQL é a que este arquivo aplica; a
-- camada TypeScript, api/_ai-gateway/cost-estimator.ts, agora calcula uma
-- estimativa conservadora REAL a partir de estimatedMetrics × provider_pricing
-- em vez de nunca popular esse campo):
--   1. TypeScript (já corrigido, ver enforcement.ts): estimatedCostUsd
--      enviado à reserva agora é um número real (quantidade × preço) sempre
--      que toda métrica faturável tem preço ativo, ou NULL explicitamente
--      quando não é possível provar — nunca mais "esquecido"/undefined.
--   2. SQL (este arquivo): um p_estimated_cost_usd NULL contra um escopo que
--      TEM um limite configurado agora falha fechado (bloqueia com
--      BUDGET_EXCEEDED, blocked_detail sufixado ':estimate_unavailable'),
--      em vez de COALESCE para 0. Um escopo SEM limite configurado continua
--      sendo pulado (CONTINUE) exatamente como antes — esta correção nunca
--      bloqueia uma chamada quando nenhum budget real está em vigor naquele
--      escopo.
--
-- Corpo idêntico ao atualmente aplicado (migration 20260718030000), com a
-- ÚNICA mudança de comportamento sendo a nova checagem "NULL bloqueia"
-- inserida no início da Fase 2, marcada abaixo com "FIX:".
-- =============================================================================

-- ── Snapshot antes: nada nesta migration deve alterar runtime controls,     ──
-- ── modo do gateway, preços ativos ou dados reais de consumo.               ──
do $$
declare
  v_runtime_controls_hash text;
  v_pricing_hash          text;
  v_counts                jsonb;
begin
  select md5(coalesce(string_agg(md5(t::text), '|' order by t.id), ''))
    into v_runtime_controls_hash from public.ai_runtime_controls t;
  select md5(coalesce(string_agg(md5(t::text), '|' order by t.id), ''))
    into v_pricing_hash from public.provider_pricing t;

  select jsonb_build_object(
    'usage_reservations',        (select count(*) from public.usage_reservations),
    'budget_buckets',            (select count(*) from public.ai_gateway_budget_buckets),
    'quota_buckets',             (select count(*) from public.ai_gateway_quota_buckets),
    'reservation_budget_links',  (select count(*) from public.ai_gateway_reservation_budget_links),
    'idempotency_locks',         (select count(*) from public.ai_gateway_idempotency_locks),
    'circuit_breakers',          (select count(*) from public.ai_gateway_circuit_breakers)
  ) into v_counts;

  create temp table if not exists _migration_724030000_snapshot (k text primary key, v text);
  delete from _migration_724030000_snapshot;
  insert into _migration_724030000_snapshot values
    ('runtime_controls_hash', v_runtime_controls_hash),
    ('pricing_hash', v_pricing_hash),
    ('counts', v_counts::text);
end $$;

-- ── Fix: CREATE OR REPLACE reserve_gateway_usage_v1 ─────────────────────────
CREATE OR REPLACE FUNCTION public.reserve_gateway_usage_v1(
  p_idempotency_key text,
  p_user_id uuid,
  p_initiated_by_user_id uuid,
  p_feature_key text,
  p_provider text,
  p_model text,
  p_metrics jsonb,
  p_budget_scopes jsonb,
  p_estimated_cost_usd numeric,
  p_expires_in_seconds integer
)
 RETURNS TABLE(reservation_id uuid, status text, expires_at timestamp with time zone, blocked_reason text, blocked_detail text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_now             TIMESTAMPTZ := NOW();
  v_expires_at      TIMESTAMPTZ;
  v_id              UUID;
  v_status          TEXT;
  v_subject_type    TEXT;
  v_item            JSONB;
  v_bucket          public.ai_gateway_quota_buckets;
  v_budget_bucket   public.ai_gateway_budget_buckets;
  v_available       NUMERIC;
  v_blocked_reason  TEXT := NULL;
  v_blocked_detail  TEXT := NULL;
  v_scope_priority  INTEGER;
BEGIN
  IF p_idempotency_key IS NULL OR char_length(p_idempotency_key) = 0 THEN
    RAISE EXCEPTION 'idempotency_key is required';
  END IF;
  IF p_feature_key IS NULL OR p_provider IS NULL THEN
    RAISE EXCEPTION 'feature_key and provider are required';
  END IF;
  IF p_expires_in_seconds IS NULL OR p_expires_in_seconds <= 0 OR p_expires_in_seconds > 3600 THEN
    RAISE EXCEPTION 'expires_in_seconds must be between 1 and 3600';
  END IF;
  IF p_estimated_cost_usd IS NOT NULL AND p_estimated_cost_usd < 0 THEN
    RAISE EXCEPTION 'estimated_cost_usd must not be negative';
  END IF;

  -- Idempotent retry: an existing reservation for this key (any status,
  -- including a prior block — a blocked attempt is never persisted as a
  -- row, so FOUND here always means a real prior reservation) is returned
  -- unchanged.
  SELECT ur.id, ur.status, ur.expires_at INTO v_id, v_status, v_expires_at
    FROM public.usage_reservations ur WHERE ur.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN QUERY SELECT v_id, v_status, v_expires_at, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  v_subject_type := CASE WHEN p_user_id IS NOT NULL THEN 'user' ELSE 'system' END;
  v_expires_at := v_now + (p_expires_in_seconds * INTERVAL '1 second');

  -- ── Phase 1: lock + validate every quota bucket, deterministic order ──────
  FOR v_item IN
    SELECT value FROM jsonb_array_elements(COALESCE(p_metrics, '[]'::jsonb)) AS value
    ORDER BY (value->>'quota_key')
  LOOP
    IF v_item->>'quota_key' IS NULL THEN
      RAISE EXCEPTION 'each metrics item requires quota_key';
    END IF;

    IF v_item->'limit_quantity' IS NOT NULL AND jsonb_typeof(v_item->'limit_quantity') != 'null' THEN
      v_bucket := public._gateway_touch_quota_bucket_v1(
        v_subject_type, p_user_id, p_feature_key, v_item->>'quota_key',
        v_item->>'period_type', (v_item->>'period_start')::TIMESTAMPTZ, (v_item->>'period_end')::TIMESTAMPTZ
      );
      v_available := (v_item->>'limit_quantity')::NUMERIC - v_bucket.committed_quantity - v_bucket.reserved_quantity;
      IF (v_item->>'reserved_quantity')::NUMERIC > GREATEST(v_available, 0) THEN
        v_blocked_reason := 'QUOTA_EXCEEDED';
        v_blocked_detail := v_item->>'quota_key';
        EXIT;
      END IF;
    END IF;
  END LOOP;

  -- ── Phase 2: lock + validate every budget scope, deterministic order ──────
  IF v_blocked_reason IS NULL THEN
    FOR v_item IN
      SELECT value FROM jsonb_array_elements(COALESCE(p_budget_scopes, '[]'::jsonb)) AS value
      ORDER BY
        (CASE value->>'scope_type'
          WHEN 'user' THEN 1 WHEN 'plan' THEN 2 WHEN 'feature' THEN 3 WHEN 'provider' THEN 4 WHEN 'global' THEN 5 ELSE 6
        END),
        (value->>'scope_key')
    LOOP
      IF v_item->'limit_usd' IS NULL OR jsonb_typeof(v_item->'limit_usd') = 'null' THEN
        CONTINUE;
      END IF;

      -- FIX (this migration): a NULL estimate against a scope that DOES have
      -- a configured limit must never be treated as "$0 / this call is
      -- free" — that was the exact bug (COALESCE(p_estimated_cost_usd, 0)
      -- below, previously the ONLY handling). "We cannot prove this call's
      -- worst-case cost is affordable" now fails closed here, exactly like
      -- an estimate that resolved to a number larger than what remains —
      -- checked BEFORE touching/locking the bucket, since there is nothing
      -- to increment when blocking. A scope with no configured limit was
      -- already skipped above (CONTINUE) and stays skipped — this never
      -- blocks a call in a scope where no real budget is in effect.
      IF p_estimated_cost_usd IS NULL THEN
        v_blocked_reason := 'BUDGET_EXCEEDED';
        v_blocked_detail := v_item->>'scope_type' || ':' || (v_item->>'scope_key') || ':estimate_unavailable';
        EXIT;
      END IF;

      v_budget_bucket := public._gateway_touch_budget_bucket_v1(
        v_item->>'scope_type', v_item->>'scope_key', v_item->>'period_type',
        (v_item->>'period_start')::TIMESTAMPTZ, (v_item->>'period_end')::TIMESTAMPTZ
      );
      v_available := (v_item->>'limit_usd')::NUMERIC - v_budget_bucket.committed_cost_usd - v_budget_bucket.reserved_cost_usd;
      IF p_estimated_cost_usd > GREATEST(v_available, 0) THEN
        v_blocked_reason := 'BUDGET_EXCEEDED';
        v_blocked_detail := v_item->>'scope_type' || ':' || (v_item->>'scope_key');
        EXIT;
      END IF;
    END LOOP;
  END IF;

  IF v_blocked_reason IS NOT NULL THEN
    -- Nothing was written — the locks acquired above are released when this
    -- function returns and the enclosing (single-statement RPC) transaction
    -- commits, with no row ever modified.
    RETURN QUERY SELECT NULL::UUID, 'blocked'::TEXT, NULL::TIMESTAMPTZ, v_blocked_reason, v_blocked_detail;
    RETURN;
  END IF;

  -- ── Phase 3: everything validated — create the reservation and apply increments ──
  BEGIN
    INSERT INTO public.usage_reservations (
      request_id, idempotency_key, user_id, initiated_by_user_id,
      feature_key, status, estimated_cost_usd, expires_at, metadata
    ) VALUES (
      gen_random_uuid(), p_idempotency_key, p_user_id, p_initiated_by_user_id,
      p_feature_key, 'pending', p_estimated_cost_usd, v_expires_at,
      jsonb_build_object('provider', p_provider, 'model', p_model)
    )
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    -- Lost the idempotency-key race to a concurrent identical retry (the
    -- buckets above were touched but not incremented by either racer until
    -- this point, so no double-increment risk) — return the winner's row.
    SELECT ur.id, ur.status, ur.expires_at INTO v_id, v_status, v_expires_at
      FROM public.usage_reservations ur WHERE ur.idempotency_key = p_idempotency_key;
    RETURN QUERY SELECT v_id, v_status, v_expires_at, NULL::TEXT, NULL::TEXT;
    RETURN;
  END;

  FOR v_item IN
    SELECT value FROM jsonb_array_elements(COALESCE(p_metrics, '[]'::jsonb)) AS value
    ORDER BY (value->>'quota_key')
  LOOP
    v_bucket.id := NULL;
    IF v_item->'limit_quantity' IS NOT NULL AND jsonb_typeof(v_item->'limit_quantity') != 'null' THEN
      v_bucket := public._gateway_touch_quota_bucket_v1(
        v_subject_type, p_user_id, p_feature_key, v_item->>'quota_key',
        v_item->>'period_type', (v_item->>'period_start')::TIMESTAMPTZ, (v_item->>'period_end')::TIMESTAMPTZ
      );
      UPDATE public.ai_gateway_quota_buckets
        SET reserved_quantity = reserved_quantity + (v_item->>'reserved_quantity')::NUMERIC, updated_at = v_now
        WHERE id = v_bucket.id;
    END IF;

    INSERT INTO public.usage_reservation_items (
      reservation_id, quota_key, unit_type, reserved_quantity, quota_bucket_id
    ) VALUES (
      v_id, v_item->>'quota_key', COALESCE(v_item->>'unit_type', 'unit'),
      COALESCE((v_item->>'reserved_quantity')::NUMERIC, 0), v_bucket.id
    );
  END LOOP;

  FOR v_item IN
    SELECT value FROM jsonb_array_elements(COALESCE(p_budget_scopes, '[]'::jsonb)) AS value
  LOOP
    IF v_item->'limit_usd' IS NULL OR jsonb_typeof(v_item->'limit_usd') = 'null' THEN
      CONTINUE;
    END IF;
    -- Reachable only when p_estimated_cost_usd IS NOT NULL for THIS scope
    -- (Phase 2 above already blocked and returned otherwise) — the
    -- COALESCE(..., 0) here is defensive, never a live $0-substitution for
    -- a scope that actually has a configured limit.
    v_budget_bucket := public._gateway_touch_budget_bucket_v1(
      v_item->>'scope_type', v_item->>'scope_key', v_item->>'period_type',
      (v_item->>'period_start')::TIMESTAMPTZ, (v_item->>'period_end')::TIMESTAMPTZ
    );
    UPDATE public.ai_gateway_budget_buckets
      SET reserved_cost_usd = reserved_cost_usd + COALESCE(p_estimated_cost_usd, 0), updated_at = v_now
      WHERE id = v_budget_bucket.id;

    INSERT INTO public.ai_gateway_reservation_budget_links (reservation_id, budget_bucket_id, reserved_cost_usd)
      VALUES (v_id, v_budget_bucket.id, COALESCE(p_estimated_cost_usd, 0))
      ON CONFLICT ON CONSTRAINT uq_agrbl_reservation_bucket DO NOTHING;
  END LOOP;

  RETURN QUERY SELECT v_id, 'pending'::TEXT, v_expires_at, NULL::TEXT, NULL::TEXT;
END;
$function$;

-- ── Permissions: restate exactly what is already in effect (defense in     ──
-- ── depth — CREATE OR REPLACE does not change grants, this is a no-op      ──
-- ── unless something drifted).                                             ──
REVOKE ALL ON FUNCTION public.reserve_gateway_usage_v1(text, uuid, uuid, text, text, text, jsonb, jsonb, numeric, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_gateway_usage_v1(text, uuid, uuid, text, text, text, jsonb, jsonb, numeric, integer)
  TO service_role, postgres;

-- ── Validation: exercise the exact NULL-estimate path this migration       ──
-- ── fixes, plus proves a resolved numeric estimate and an unconfigured     ──
-- ── scope both still behave exactly as before. Synthetic, future-dated     ──
-- ── scope keys so this never collides with real data. Aborts the whole     ──
-- ── migration (RAISE EXCEPTION rolls back the transaction, including the   ──
-- ── function fix above) if any expectation fails.                         ──
do $$
declare
  v_feature_key            text := 'writing.correct'; -- real, pre-existing ai_features row — never invented
  v_scope_key_a             text := '__migration_724030000_scope_a__';
  v_scope_key_b             text := '__migration_724030000_scope_b__';
  v_scope_key_c             text := '__migration_724030000_scope_c__';
  v_idem_key_a              text := '__migration_724030000_res_a__';
  v_idem_key_b              text := '__migration_724030000_res_b__';
  v_idem_key_c              text := '__migration_724030000_res_c__';
  v_period_start            timestamptz := date_trunc('month', now() + interval '50 years');
  v_period_end              timestamptz := v_period_start + interval '1 month';
  v_call                    record;
begin
  -- (a) NULL estimate against a scope WITH a configured limit → must block,
  -- BUDGET_EXCEEDED, detail suffixed ':estimate_unavailable'. This is the
  -- exact case that previously slipped through as if the call were free.
  select * into v_call from public.reserve_gateway_usage_v1(
    v_idem_key_a, null, null,
    v_feature_key, 'openai', 'gpt-test',
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'scope_type', 'global', 'scope_key', v_scope_key_a,
      'period_type', 'month', 'period_start', v_period_start, 'period_end', v_period_end,
      'limit_usd', 100
    )),
    NULL, 60
  );
  IF v_call.status IS DISTINCT FROM 'blocked' OR v_call.blocked_reason IS DISTINCT FROM 'BUDGET_EXCEEDED' THEN
    RAISE EXCEPTION 'VALIDATION FAILED: NULL estimate against a configured budget scope should block with BUDGET_EXCEEDED (got status=%, reason=%)', v_call.status, v_call.blocked_reason;
  END IF;
  IF v_call.blocked_detail NOT LIKE '%:estimate_unavailable' THEN
    RAISE EXCEPTION 'VALIDATION FAILED: expected blocked_detail to end with :estimate_unavailable, got %', v_call.blocked_detail;
  END IF;
  IF EXISTS (SELECT 1 FROM public.usage_reservations WHERE idempotency_key = v_idem_key_a) THEN
    RAISE EXCEPTION 'VALIDATION FAILED: a blocked NULL-estimate call must never persist a reservation row';
  END IF;

  -- (b) Resolved numeric estimate under the remaining budget → still
  -- succeeds exactly as before this fix (proves the fix is additive, not a
  -- new false block on the normal, already-working path).
  select * into v_call from public.reserve_gateway_usage_v1(
    v_idem_key_b, null, null,
    v_feature_key, 'openai', 'gpt-test',
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'scope_type', 'global', 'scope_key', v_scope_key_a,
      'period_type', 'month', 'period_start', v_period_start, 'period_end', v_period_end,
      'limit_usd', 100
    )),
    1.5, 60
  );
  IF v_call.status IS DISTINCT FROM 'pending' OR v_call.reservation_id IS NULL THEN
    RAISE EXCEPTION 'VALIDATION FAILED: a resolved estimate under budget should still reserve normally (got status=%, id=%)', v_call.status, v_call.reservation_id;
  END IF;

  -- (c) NULL estimate against a scope with NO configured limit anywhere →
  -- must proceed exactly as before — this fix must never block a call in a
  -- scope where no real budget is in effect (matches today's production
  -- reality: every scope currently has daily_budget_usd/monthly_budget_usd
  -- = NULL).
  select * into v_call from public.reserve_gateway_usage_v1(
    v_idem_key_c, null, null,
    v_feature_key, 'openai', 'gpt-test',
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'scope_type', 'global', 'scope_key', v_scope_key_c,
      'period_type', 'month', 'period_start', v_period_start, 'period_end', v_period_end,
      'limit_usd', NULL
    )),
    NULL, 60
  );
  IF v_call.status IS DISTINCT FROM 'pending' OR v_call.reservation_id IS NULL THEN
    RAISE EXCEPTION 'VALIDATION FAILED: a NULL estimate against an unconfigured (no limit_usd) scope must still reserve normally (got status=%, id=%)', v_call.status, v_call.reservation_id;
  END IF;

  -- Clean up every synthetic row created by this validation, before COMMIT.
  DELETE FROM public.ai_gateway_reservation_budget_links
    WHERE reservation_id IN (SELECT id FROM public.usage_reservations WHERE idempotency_key IN (v_idem_key_a, v_idem_key_b, v_idem_key_c));
  DELETE FROM public.usage_reservation_items
    WHERE reservation_id IN (SELECT id FROM public.usage_reservations WHERE idempotency_key IN (v_idem_key_a, v_idem_key_b, v_idem_key_c));
  DELETE FROM public.usage_reservations WHERE idempotency_key IN (v_idem_key_a, v_idem_key_b, v_idem_key_c);
  DELETE FROM public.ai_gateway_budget_buckets WHERE scope_type = 'global' AND scope_key IN (v_scope_key_a, v_scope_key_b, v_scope_key_c);

  RAISE NOTICE '[migration 724030000] validation passed: NULL-vs-configured-limit blocks, resolved estimate still reserves, NULL-vs-unconfigured-limit still reserves';
end $$;

-- ── Final snapshot comparison — abort if anything protected drifted, or   ──
-- ── if validation left synthetic data behind.                             ──
do $$
declare
  v_runtime_controls_hash_before text;
  v_pricing_hash_before          text;
  v_counts_before                jsonb;
  v_runtime_controls_hash_after  text;
  v_pricing_hash_after           text;
  v_counts_after                 jsonb;
begin
  select v into v_runtime_controls_hash_before from _migration_724030000_snapshot where k = 'runtime_controls_hash';
  select v into v_pricing_hash_before          from _migration_724030000_snapshot where k = 'pricing_hash';
  select v::jsonb into v_counts_before         from _migration_724030000_snapshot where k = 'counts';

  select md5(coalesce(string_agg(md5(t::text), '|' order by t.id), ''))
    into v_runtime_controls_hash_after from public.ai_runtime_controls t;
  select md5(coalesce(string_agg(md5(t::text), '|' order by t.id), ''))
    into v_pricing_hash_after from public.provider_pricing t;

  select jsonb_build_object(
    'usage_reservations',        (select count(*) from public.usage_reservations),
    'budget_buckets',            (select count(*) from public.ai_gateway_budget_buckets),
    'quota_buckets',             (select count(*) from public.ai_gateway_quota_buckets),
    'reservation_budget_links',  (select count(*) from public.ai_gateway_reservation_budget_links),
    'idempotency_locks',         (select count(*) from public.ai_gateway_idempotency_locks),
    'circuit_breakers',          (select count(*) from public.ai_gateway_circuit_breakers)
  ) into v_counts_after;

  IF v_runtime_controls_hash_before IS DISTINCT FROM v_runtime_controls_hash_after THEN
    RAISE EXCEPTION 'ABORT: ai_runtime_controls changed during this migration — refusing to commit';
  END IF;
  IF v_pricing_hash_before IS DISTINCT FROM v_pricing_hash_after THEN
    RAISE EXCEPTION 'ABORT: provider_pricing changed during this migration — refusing to commit';
  END IF;
  IF v_counts_before IS DISTINCT FROM v_counts_after THEN
    RAISE EXCEPTION 'ABORT: consumption/reservation table row counts drifted (before=%, after=%) — validation cleanup incomplete or unrelated data touched', v_counts_before, v_counts_after;
  END IF;

  DROP TABLE _migration_724030000_snapshot;
  RAISE NOTICE '[migration 724030000] snapshot check passed — no drift in ai_runtime_controls, provider_pricing, or consumption tables';
end $$;
