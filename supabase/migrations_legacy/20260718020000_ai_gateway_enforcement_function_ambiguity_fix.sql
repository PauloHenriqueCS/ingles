-- =============================================================================
-- MIGRATION: 20260718020000_ai_gateway_enforcement_function_ambiguity_fix
-- Projeto: Lemon (english learning app)
--
-- Correção ADITIVA sobre 20260718000000_ai_gateway_enforcement (já aplicada
-- remotamente — não alterada) e 20260718010000_ai_gateway_enforcement_
-- security_fix (idem). Nenhuma das duas é editada por este arquivo.
--
-- EVIDÊNCIA REAL (Primary Database, execução do BLOCO A de
-- ai-gateway-enforcement-concurrency.sql em 2026-07-18, rollback proposital,
-- nenhum dado persistido):
--   2_dedupe_atomic_and_reclaim  FAIL  column reference "result_ref" is ambiguous
--   3_reservation_idempotency    FAIL  column reference "status" is ambiguous
--   7_backfill_on_first_touch    FAIL  column reference "status" is ambiguous
--   1_rate_limit_atomic          PASS
--   6_breaker_probe_exclusivity  PASS
--
-- AUDITORIA (todas as 18 funções da Etapa 11, revisão linha a linha contra o
-- texto real da migration aplicada): a causa é sempre a mesma classe de bug —
-- RETURNS TABLE(col1, col2, ...) injeta, implicitamente, uma variável
-- PL/pgSQL por coluna de saída, visível em toda a função. Quando o corpo
-- referencia SEM QUALIFICAÇÃO uma coluna real de mesmo nome (de uma tabela
-- na consulta embutida), o Postgres não consegue decidir entre a variável
-- de saída e a coluna da tabela — e falha em tempo de execução (não na
-- criação da função), com "column reference X is ambiguous".
--
-- Apenas 2 das 18 funções são afetadas:
--   • begin_gateway_idempotent_op_v1 — RETURNS TABLE(lock_id, outcome,
--     result_ref). A tabela ai_gateway_idempotency_locks tem uma coluna
--     result_ref. Duas ocorrências sem qualificação: no RETURNING do
--     INSERT...ON CONFLICT DO UPDATE, e no SELECT de fallback logo depois.
--     "outcome" não é nome de coluna real (não colide) e "lock_id" também
--     não (a coluna é "id") — só result_ref colide.
--   • reserve_gateway_usage_v1 — RETURNS TABLE(reservation_id, status,
--     expires_at, blocked_reason, blocked_detail). A tabela
--     usage_reservations tem uma coluna status. Duas ocorrências sem
--     qualificação: no SELECT de idempotent-retry (a PRIMEIRA instrução
--     executada em TODA chamada da função, incondicionalmente — por isso
--     quebrou tanto o Cenário 3, que chama a função duas vezes, quanto o
--     Cenário 7, que chama uma vez só) e no handler EXCEPTION WHEN
--     unique_violation. "reservation_id" não é nome de coluna real de
--     usage_reservations (a coluna é "id") e "expires_at" já estava
--     corretamente qualificado como usage_reservations.expires_at no
--     arquivo original — só "status" ficou sem qualificação.
--
-- As outras 16 funções foram auditadas e confirmadas limpas:
--   • RETURNS VOID / escalar (JSONB, INTEGER, UUID) / TRIGGER: não injetam
--     variáveis de saída nomeadas — sem risco algum desta classe de bug,
--     independentemente do nome de qualquer coluna.
--   • RETURNS <tipo composto> (_gateway_touch_quota_bucket_v1,
--     _gateway_touch_budget_bucket_v1 — RETURNS public.ai_gateway_
--     quota_buckets / public.ai_gateway_budget_buckets): um tipo de retorno
--     composto NÃO é o mesmo que RETURNS TABLE(...) — não injeta variáveis
--     nomeadas, sem risco.
--   • get_gateway_breaker_state_v1 (RETURNS TABLE(state, probe_allowed)) e
--     record_gateway_breaker_outcome_v1 (RETURNS TABLE(state)): a tabela
--     ai_gateway_circuit_breakers TEM uma coluna "state" — mas toda
--     referência a ela no corpo passa por "SELECT *"/"RETURNING *" (sem
--     ambiguidade — "*" não é uma identificação nominal sujeita a esta
--     checagem) ou por "v_row.state" (acesso a campo de record, também sem
--     ambiguidade) — nunca "state" nu. Confirmado limpo tanto pela leitura
--     estática quanto pela evidência real: 6_breaker_probe_exclusivity
--     passou.
-- Detalhe completo por função documentado inline abaixo, no ponto de cada
-- correção.
--
-- ESCOPO DESTA MIGRATION: EXCLUSIVAMENTE as referências ambíguas
-- comprovadas acima. Nenhuma regra de quota, orçamento, deduplicação,
-- circuit breaker ou reserva é alterada — cada CREATE OR REPLACE abaixo
-- reproduz o corpo original byte a byte, exceto pela qualificação explícita
-- (alias de tabela) das colunas identificadas. Nenhum #variable_conflict é
-- usado (mascararia a causa em vez de eliminá-la, e continuaria frágil a
-- qualquer nova coluna futura de mesmo nome). Assinatura pública, tipo de
-- retorno, LANGUAGE, SECURITY DEFINER, SET search_path e ownership
-- (postgres, inalterado — CREATE OR REPLACE nunca muda o dono de uma
-- função existente) preservados exatamente.
-- =============================================================================

BEGIN;

-- Real before-snapshot — mesmo padrão das duas migrations anteriores desta
-- etapa: esta correção nunca deveria alterar gateway_mode/runtime_status
-- (ela não escreve em ai_runtime_controls) nem provider_pricing (não
-- escreve em provider_pricing); a validação final compara contra este
-- estado genuíno anterior.
CREATE TEMP TABLE _ambiguity_fix_runtime_before AS
  SELECT id, gateway_mode, runtime_status FROM public.ai_runtime_controls;

CREATE TEMP TABLE _ambiguity_fix_pricing_before AS
  SELECT id, provider, model, metric_key, price_per_unit, is_active, source_reference
  FROM public.provider_pricing;

-- ─────────────────────────────────────────────────────────────────────────────
-- FIX 1: begin_gateway_idempotent_op_v1 — result_ref qualificado com alias
-- ─────────────────────────────────────────────────────────────────────────────
-- Alias "agil" (ai_gateway_idempotency_locks) aplicado tanto no INSERT-alvo
-- quanto no SELECT de fallback, qualificando TODAS as colunas referenciadas
-- (não só a que colidia) para consistência e para blindar contra qualquer
-- futura coluna de mesmo nome que uma saída da função. Comportamento
-- idêntico ao original: mesma lógica de ON CONFLICT, mesma condição de
-- reclaim (status='failed' OR expires_at expirado), mesmo fallback SELECT
-- quando o UPDATE do ON CONFLICT não afeta nenhuma linha (lock ainda
-- 'in_progress' e não expirado).
CREATE OR REPLACE FUNCTION public.begin_gateway_idempotent_op_v1(
  p_scope           TEXT,
  p_idempotency_key TEXT,
  p_lease_seconds   INTEGER
)
RETURNS TABLE(lock_id UUID, outcome TEXT, result_ref TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now        TIMESTAMPTZ := NOW();
  v_id         UUID;
  v_status     TEXT;
  v_result_ref TEXT;
  v_was_insert BOOLEAN;
BEGIN
  IF p_scope IS NULL OR char_length(p_scope) = 0 OR char_length(p_scope) > 128 THEN
    RAISE EXCEPTION 'invalid scope';
  END IF;
  IF p_idempotency_key IS NULL OR char_length(p_idempotency_key) = 0 OR char_length(p_idempotency_key) > 256 THEN
    RAISE EXCEPTION 'invalid idempotency_key';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds <= 0 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'lease_seconds must be between 1 and 3600';
  END IF;

  INSERT INTO public.ai_gateway_idempotency_locks AS agil (scope, idempotency_key, status, expires_at)
  VALUES (p_scope, p_idempotency_key, 'in_progress', v_now + (p_lease_seconds * INTERVAL '1 second'))
  ON CONFLICT (scope, idempotency_key) DO UPDATE
    SET status     = 'in_progress',
        result_ref = NULL,
        expires_at = v_now + (p_lease_seconds * INTERVAL '1 second'),
        updated_at = v_now
    WHERE agil.status = 'failed'
       OR agil.expires_at <= v_now
  RETURNING agil.id, agil.status, agil.result_ref, (agil.xmax = 0) INTO v_id, v_status, v_result_ref, v_was_insert;

  IF FOUND THEN
    RETURN QUERY SELECT v_id, (CASE WHEN v_was_insert THEN 'started' ELSE 'reclaimed' END), v_result_ref;
    RETURN;
  END IF;

  SELECT agil.id, agil.status, agil.result_ref INTO v_id, v_status, v_result_ref
    FROM public.ai_gateway_idempotency_locks agil
    WHERE agil.scope = p_scope AND agil.idempotency_key = p_idempotency_key;

  RETURN QUERY SELECT v_id, v_status, v_result_ref;
END;
$$;

REVOKE ALL ON FUNCTION public.begin_gateway_idempotent_op_v1(TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_gateway_idempotent_op_v1(TEXT, TEXT, INTEGER) TO service_role, postgres;

-- ─────────────────────────────────────────────────────────────────────────────
-- FIX 2: reserve_gateway_usage_v1 — status qualificado com alias
-- ─────────────────────────────────────────────────────────────────────────────
-- Alias "ur" (usage_reservations) aplicado nas duas ocorrências do SELECT de
-- idempotent-retry (a checagem inicial, incondicional em toda chamada, e o
-- handler EXCEPTION WHEN unique_violation, que reexecuta a mesma checagem
-- após perder a corrida do idempotency_key). "expires_at" já estava
-- qualificado no arquivo original (usage_reservations.expires_at) — mantido,
-- só trocado para o alias por consistência. Nenhuma outra linha da função
-- foi tocada: as fases 1/2/3 (locks de quota/budget, criação da reserva,
-- incrementos) já não tinham nenhuma referência ambígua (colunas como
-- reserved_quantity/reserved_cost_usd não colidem com nenhuma saída da
-- função, e toda lista de colunas de INSERT/ON CONFLICT — incluindo as que
-- se chamam "reservation_id" — é resolvida contra o esquema da tabela-alvo,
-- nunca contra variáveis PL/pgSQL, então nunca é ambígua).
CREATE OR REPLACE FUNCTION public.reserve_gateway_usage_v1(
  p_idempotency_key      TEXT,
  p_user_id              UUID,
  p_initiated_by_user_id UUID,
  p_feature_key          TEXT,
  p_provider             TEXT,
  p_model                TEXT,
  p_metrics              JSONB,
  p_budget_scopes        JSONB,
  p_estimated_cost_usd   NUMERIC,
  p_expires_in_seconds   INTEGER
)
RETURNS TABLE(reservation_id UUID, status TEXT, expires_at TIMESTAMPTZ, blocked_reason TEXT, blocked_detail TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  -- (sorted by quota_key — jsonb_array_elements over a value produced by
  -- `jsonb_agg(... ORDER BY ...)` on the TS side is not guaranteed to
  -- preserve order through JSON transport in every driver, so we re-sort
  -- here explicitly rather than trust input ordering.)
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

      v_budget_bucket := public._gateway_touch_budget_bucket_v1(
        v_item->>'scope_type', v_item->>'scope_key', v_item->>'period_type',
        (v_item->>'period_start')::TIMESTAMPTZ, (v_item->>'period_end')::TIMESTAMPTZ
      );
      v_available := (v_item->>'limit_usd')::NUMERIC - v_budget_bucket.committed_cost_usd - v_budget_bucket.reserved_cost_usd;
      IF COALESCE(p_estimated_cost_usd, 0) > GREATEST(v_available, 0) THEN
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
    v_budget_bucket := public._gateway_touch_budget_bucket_v1(
      v_item->>'scope_type', v_item->>'scope_key', v_item->>'period_type',
      (v_item->>'period_start')::TIMESTAMPTZ, (v_item->>'period_end')::TIMESTAMPTZ
    );
    UPDATE public.ai_gateway_budget_buckets
      SET reserved_cost_usd = reserved_cost_usd + COALESCE(p_estimated_cost_usd, 0), updated_at = v_now
      WHERE id = v_budget_bucket.id;
    INSERT INTO public.ai_gateway_reservation_budget_links (reservation_id, budget_bucket_id, reserved_cost_usd)
      VALUES (v_id, v_budget_bucket.id, COALESCE(p_estimated_cost_usd, 0))
      ON CONFLICT (reservation_id, budget_bucket_id) DO NOTHING;
  END LOOP;

  RETURN QUERY SELECT v_id, 'pending'::TEXT, v_expires_at, NULL::TEXT, NULL::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_gateway_usage_v1(TEXT, UUID, UUID, TEXT, TEXT, TEXT, JSONB, JSONB, NUMERIC, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_gateway_usage_v1(TEXT, UUID, UUID, TEXT, TEXT, TEXT, JSONB, JSONB, NUMERIC, INTEGER) TO service_role, postgres;

-- =============================================================================
-- VALIDAÇÃO TRANSACIONAL
-- =============================================================================

DO $$
DECLARE
  v_row_count_before   INTEGER;
  v_row_count_after    INTEGER;
  v_changed_runtime    INTEGER;
  v_changed_pricing    INTEGER;
  v_probe_lock         RECORD;
  v_res_id_a           UUID;
  v_res_id_b           UUID;
  v_res_count          INTEGER;
  v_backfill_committed NUMERIC;
  v_backfill_flag      BOOLEAN;
BEGIN
  -- (a) as duas funções corrigidas continuam existindo com a MESMA
  -- assinatura pública (CREATE OR REPLACE já teria falhado sozinho se a
  -- assinatura tivesse mudado incompativelmente, mas confirmamos
  -- explicitamente aqui em vez de confiar apenas nisso).
  IF to_regprocedure('public.begin_gateway_idempotent_op_v1(text, text, integer)') IS NULL THEN
    RAISE EXCEPTION 'VALIDATION FAILED: begin_gateway_idempotent_op_v1(text,text,integer) not found after CREATE OR REPLACE';
  END IF;
  IF to_regprocedure('public.reserve_gateway_usage_v1(text, uuid, uuid, text, text, text, jsonb, jsonb, numeric, integer)') IS NULL THEN
    RAISE EXCEPTION 'VALIDATION FAILED: reserve_gateway_usage_v1(...) not found after CREATE OR REPLACE';
  END IF;

  -- (b) privilégios seguros nas duas funções: anon/authenticated sem
  -- EXECUTE, service_role com EXECUTE — reafirmado pelo REVOKE/GRANT acima,
  -- verificado ao vivo aqui.
  IF has_function_privilege('anon', 'public.begin_gateway_idempotent_op_v1(text, text, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.begin_gateway_idempotent_op_v1(text, text, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VALIDATION FAILED: anon/authenticated still has EXECUTE on begin_gateway_idempotent_op_v1';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.begin_gateway_idempotent_op_v1(text, text, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VALIDATION FAILED: service_role is missing EXECUTE on begin_gateway_idempotent_op_v1';
  END IF;
  IF has_function_privilege('anon', 'public.reserve_gateway_usage_v1(text, uuid, uuid, text, text, text, jsonb, jsonb, numeric, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.reserve_gateway_usage_v1(text, uuid, uuid, text, text, text, jsonb, jsonb, numeric, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VALIDATION FAILED: anon/authenticated still has EXECUTE on reserve_gateway_usage_v1';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.reserve_gateway_usage_v1(text, uuid, uuid, text, text, text, jsonb, jsonb, numeric, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VALIDATION FAILED: service_role is missing EXECUTE on reserve_gateway_usage_v1';
  END IF;

  -- (c) prova funcional real, dentro da própria transação da migration:
  -- exercita exatamente o caminho que quebrou (begin -> in_progress ->
  -- fail -> reclaimed) e o de reserve_gateway_usage_v1 (idempotent retry
  -- sem ambiguidade), com marcadores sintéticos exclusivos desta migration
  -- (nunca colidem com tráfego real) — e desfaz tudo antes de continuar,
  -- para não deixar nenhuma linha de teste na base.
  PERFORM public.begin_gateway_idempotent_op_v1('migration-selftest:20260718020000', 'k1', 30);
  SELECT lock_id, outcome INTO v_probe_lock
    FROM public.begin_gateway_idempotent_op_v1('migration-selftest:20260718020000', 'k1', 30);
  IF v_probe_lock.outcome IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'VALIDATION FAILED: begin_gateway_idempotent_op_v1 self-test expected in_progress on second call, got %', v_probe_lock.outcome;
  END IF;
  PERFORM public.fail_gateway_idempotent_op_v1(v_probe_lock.lock_id);
  SELECT outcome INTO v_probe_lock FROM public.begin_gateway_idempotent_op_v1('migration-selftest:20260718020000', 'k1', 30);
  IF v_probe_lock.outcome IS DISTINCT FROM 'reclaimed' THEN
    RAISE EXCEPTION 'VALIDATION FAILED: begin_gateway_idempotent_op_v1 self-test expected reclaimed after fail, got % (result_ref ambiguity likely still present)', v_probe_lock.outcome;
  END IF;
  DELETE FROM public.ai_gateway_idempotency_locks WHERE scope = 'migration-selftest:20260718020000';

  SELECT reservation_id INTO v_res_id_a FROM public.reserve_gateway_usage_v1(
    'migration-selftest-20260718020000', NULL, NULL, 'writing.correct', 'openai', 'gpt-4o-mini',
    '[]'::jsonb, '[]'::jsonb, NULL, 60
  );
  -- segunda chamada, mesma idempotency_key — é exatamente a linha que
  -- lançava "column reference status is ambiguous" antes desta correção.
  SELECT reservation_id INTO v_res_id_b FROM public.reserve_gateway_usage_v1(
    'migration-selftest-20260718020000', NULL, NULL, 'writing.correct', 'openai', 'gpt-4o-mini',
    '[]'::jsonb, '[]'::jsonb, NULL, 60
  );
  IF v_res_id_a IS DISTINCT FROM v_res_id_b OR v_res_id_a IS NULL THEN
    RAISE EXCEPTION 'VALIDATION FAILED: reserve_gateway_usage_v1 self-test expected both calls to return the SAME reservation_id, got % and %', v_res_id_a, v_res_id_b;
  END IF;
  SELECT COUNT(*) INTO v_res_count FROM public.usage_reservations WHERE idempotency_key = 'migration-selftest-20260718020000';
  IF v_res_count != 1 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: reserve_gateway_usage_v1 self-test expected exactly 1 row for this idempotency_key, found %', v_res_count;
  END IF;
  DELETE FROM public.usage_reservation_items WHERE reservation_id IN (
    SELECT id FROM public.usage_reservations WHERE idempotency_key = 'migration-selftest-20260718020000');
  DELETE FROM public.usage_reservations WHERE idempotency_key = 'migration-selftest-20260718020000';

  -- Self-test adicional: reserve_gateway_usage_v1 COM quota (limit_quantity
  -- preenchido), o caminho que realmente exercita _gateway_touch_quota_
  -- bucket_v1 e o backfill de committed_quantity a partir de um evento real
  -- já existente no período — não apenas o caminho vazio (p_metrics=[])
  -- testado acima. subject_type='system' (p_user_id NULL) evita depender
  -- de uma linha real em auth.users dentro desta migration. Marcador fixo
  -- 'bbbbbbbb-0000-0000-0000-000000000020' e período 2099-03, exclusivos
  -- desta migration — nunca colidem com o Cenário 7 de
  -- ai-gateway-enforcement-concurrency.sql (marcador 'aaaaaaaa-...-007',
  -- período 2099-01) nem com tráfego real.
  INSERT INTO public.ai_usage_events (
    id, request_id, user_id, actor_type, feature_key, provider, execution_location, status, is_billable, started_at
  ) VALUES (
    'bbbbbbbb-0000-0000-0000-000000000020'::uuid, 'bbbbbbbb-0000-0000-0000-000000000020'::uuid,
    NULL, 'system', 'writing.correct', 'openai', 'backend', 'succeeded', true, '2099-03-15T00:00:00Z'
  );
  INSERT INTO public.ai_usage_event_metrics (usage_event_id, metric_key, unit_type, quantity, is_billable, measurement_source)
    VALUES ('bbbbbbbb-0000-0000-0000-000000000020'::uuid, 'output_text_tokens', 'token', 321, true, 'provider_response');

  PERFORM public.reserve_gateway_usage_v1(
    'migration-selftest-backfill-20260718020000', NULL, NULL, 'writing.correct', 'openai', 'gpt-4o-mini',
    '[{"quota_key":"output_text_tokens","unit_type":"token","reserved_quantity":10,"limit_quantity":10000,"period_type":"month","period_start":"2099-03-01T00:00:00Z","period_end":"2099-04-01T00:00:00Z"}]'::jsonb,
    '[]'::jsonb, NULL, 60
  );

  SELECT committed_quantity, backfilled INTO v_backfill_committed, v_backfill_flag
    FROM public.ai_gateway_quota_buckets
    WHERE subject_type = 'system' AND feature_key = 'writing.correct' AND metric_key = 'output_text_tokens'
      AND period_start = '2099-03-01T00:00:00Z';
  IF v_backfill_committed IS DISTINCT FROM 321 OR v_backfill_flag IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'VALIDATION FAILED: quota-backfill self-test expected committed_quantity=321 backfilled=true, got committed_quantity=% backfilled=% (ambiguity or backfill regression)', v_backfill_committed, v_backfill_flag;
  END IF;

  DELETE FROM public.usage_reservation_items WHERE reservation_id IN (
    SELECT id FROM public.usage_reservations WHERE idempotency_key = 'migration-selftest-backfill-20260718020000');
  DELETE FROM public.usage_reservations WHERE idempotency_key = 'migration-selftest-backfill-20260718020000';
  DELETE FROM public.ai_gateway_quota_buckets
    WHERE subject_type = 'system' AND feature_key = 'writing.correct' AND metric_key = 'output_text_tokens'
      AND period_start = '2099-03-01T00:00:00Z';
  DELETE FROM public.ai_usage_event_metrics WHERE usage_event_id = 'bbbbbbbb-0000-0000-0000-000000000020'::uuid;
  DELETE FROM public.ai_usage_events WHERE id = 'bbbbbbbb-0000-0000-0000-000000000020'::uuid;

  -- (d) nenhuma linha sintética de teste sobrou.
  IF EXISTS (SELECT 1 FROM public.ai_gateway_idempotency_locks WHERE scope = 'migration-selftest:20260718020000') THEN
    RAISE EXCEPTION 'VALIDATION FAILED: self-test left a residual ai_gateway_idempotency_locks row';
  END IF;
  IF EXISTS (SELECT 1 FROM public.usage_reservations WHERE idempotency_key = 'migration-selftest-20260718020000') THEN
    RAISE EXCEPTION 'VALIDATION FAILED: self-test left a residual usage_reservations row';
  END IF;
  IF EXISTS (SELECT 1 FROM public.usage_reservations WHERE idempotency_key = 'migration-selftest-backfill-20260718020000') THEN
    RAISE EXCEPTION 'VALIDATION FAILED: quota-backfill self-test left a residual usage_reservations row';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ai_gateway_quota_buckets WHERE subject_type = 'system' AND period_start = '2099-03-01T00:00:00Z') THEN
    RAISE EXCEPTION 'VALIDATION FAILED: quota-backfill self-test left a residual ai_gateway_quota_buckets row';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ai_usage_events WHERE id = 'bbbbbbbb-0000-0000-0000-000000000020'::uuid) THEN
    RAISE EXCEPTION 'VALIDATION FAILED: quota-backfill self-test left a residual ai_usage_events row';
  END IF;

  -- (e) gateway_mode/runtime_status inalterados — esta migration não
  -- escreve em ai_runtime_controls.
  SELECT COUNT(*) INTO v_row_count_before FROM _ambiguity_fix_runtime_before;
  SELECT COUNT(*) INTO v_row_count_after FROM public.ai_runtime_controls;
  IF v_row_count_before != v_row_count_after THEN
    RAISE EXCEPTION 'VALIDATION FAILED: ai_runtime_controls row count changed (% before, % after)', v_row_count_before, v_row_count_after;
  END IF;
  SELECT COUNT(*) INTO v_changed_runtime
    FROM public.ai_runtime_controls arc
    JOIN _ambiguity_fix_runtime_before b ON b.id = arc.id
    WHERE arc.gateway_mode IS DISTINCT FROM b.gateway_mode
       OR arc.runtime_status IS DISTINCT FROM b.runtime_status;
  IF v_changed_runtime > 0 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: % existing ai_runtime_controls row(s) had gateway_mode/runtime_status changed — must be zero', v_changed_runtime;
  END IF;

  -- (f) provider_pricing inalterada — esta migration não escreve nela.
  SELECT COUNT(*) INTO v_changed_pricing
    FROM public.provider_pricing pp
    FULL JOIN _ambiguity_fix_pricing_before b ON b.id = pp.id
    WHERE pp.id IS NULL OR b.id IS NULL
       OR pp.price_per_unit IS DISTINCT FROM b.price_per_unit
       OR pp.is_active IS DISTINCT FROM b.is_active
       OR pp.source_reference IS DISTINCT FROM b.source_reference
       OR pp.provider IS DISTINCT FROM b.provider
       OR pp.model IS DISTINCT FROM b.model
       OR pp.metric_key IS DISTINCT FROM b.metric_key;
  IF v_changed_pricing > 0 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: provider_pricing differs from its pre-migration snapshot (% row(s))', v_changed_pricing;
  END IF;

  RAISE NOTICE 'VALIDATION PASSED: begin_gateway_idempotent_op_v1 and reserve_gateway_usage_v1 replaced with qualified column references; begin->in_progress->fail->reclaimed, reserve idempotent-retry (same reservation_id), and reserve-with-quota first-touch backfill self-tests all passed with zero ambiguity and zero residual rows; anon/authenticated still have no EXECUTE, service_role/postgres still do; gateway_mode/runtime_status/provider_pricing unchanged';
END;
$$;

COMMIT;

-- =============================================================================
-- ROLLBACK MANUAL (documentado, não executado por esta migration)
-- =============================================================================
--   Reverter esta correção reintroduziria os bugs de ambiguidade — não
--   recomendado. Se algum dia necessário, reaplique o texto ORIGINAL das
--   duas funções de 20260718000000_ai_gateway_enforcement.sql via
--   CREATE OR REPLACE FUNCTION (a migration original permanece a
--   autoridade sobre o texto pré-correção, em seu próprio arquivo,
--   inalterado).
-- =============================================================================
--
-- FIM DA MIGRATION 20260718020000_ai_gateway_enforcement_function_ambiguity_fix
-- =============================================================================
