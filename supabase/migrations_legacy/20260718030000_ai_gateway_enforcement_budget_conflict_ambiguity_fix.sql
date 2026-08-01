-- =============================================================================
-- MIGRATION: 20260718030000_ai_gateway_enforcement_budget_conflict_ambiguity_fix
-- Projeto: Lemon — Etapa 11 / Bloco C
--
-- Estritamente aditiva. NÃO edita nenhuma das três migrations já aplicadas
-- (20260718000000, 20260718010000, 20260718020000) — apenas substitui
-- (CREATE OR REPLACE) a definição atual de reserve_gateway_usage_v1 por uma
-- versão corrigida, preservando assinatura, tipos de retorno, regras de
-- quota/orçamento, ordem de locks, idempotência, SECURITY DEFINER,
-- search_path, dono e permissões.
--
-- BUG REAL (reproduzido em produção, não hipotético):
--   ERROR: 42702: column reference "reservation_id" is ambiguous
--   QUERY: INSERT INTO ai_gateway_reservation_budget_links
--            (reservation_id, budget_bucket_id, reserved_cost_usd)
--          VALUES (...)
--          ON CONFLICT (reservation_id, budget_bucket_id) DO NOTHING
--
-- Causa: reserve_gateway_usage_v1 declara RETURNS TABLE(reservation_id uuid,
-- status text, expires_at timestamptz, blocked_reason text, blocked_detail
-- text) — cada coluna de saída vira uma variável PL/pgSQL implícita, em
-- escopo por toda a função. A migration 20260718020000 já havia corrigido
-- outras ambiguidades desse tipo, mas partiu da premissa de que a lista de
-- colunas de um alvo ON CONFLICT sempre resolve como referência de coluna —
-- premissa que o Postgres real, nesse contexto plpgsql, contraria: a lista
-- do ON CONFLICT aceita expressões (não é uma lista de destino pura como em
-- INSERT/UPDATE SET), então passa pela resolução normal de identificador,
-- que enxerga a variável de saída "reservation_id" antes da coluna
-- homônima da tabela. Isso só se manifesta com p_budget_scopes não vazio
-- (único caminho que chega a essa instrução), o que explica por que a
-- cobertura anterior — com budget_scopes vazio — não pegou o bug.
--
-- CORREÇÃO: troca o alvo por nome real da constraint (nunca lista de
-- colunas), conforme exigido — nome obtido do catálogo real, não inventado:
--   public.ai_gateway_reservation_budget_links
--     uq_agrbl_reservation_bucket  UNIQUE (reservation_id, budget_bucket_id)
--
--   ON CONFLICT ON CONSTRAINT uq_agrbl_reservation_bucket DO NOTHING
--
-- Não usa #variable_conflict, não renomeia a saída reservation_id, não usa
-- SQL dinâmico, não altera idempotência nem comportamento financeiro.
--
-- AUDITORIA DAS DEMAIS FUNÇÕES RETURNS TABLE DA ETAPA 11 (ver relatório
-- final para o resultado completo): _gateway_audit_database_privileges_v1,
-- begin_gateway_idempotent_op_v1, get_gateway_breaker_state_v1,
-- record_gateway_breaker_outcome_v1 — nenhuma tem alvo ON CONFLICT (ou
-- qualquer outro contexto de expressão) referenciando um identificador nu
-- que colida com sua própria coluna de saída. As ocorrências de
-- "SET <nome_da_coluna_de_saída> = valor" dentro de UPDATE (ex.: SET
-- result_ref = NULL, SET state = 'half_open') NÃO sofrem desse bug: o alvo
-- de um UPDATE...SET é sempre resolvido como coluna por gramática — ao
-- contrário do alvo do ON CONFLICT — e isso foi confirmado empiricamente
-- (não apenas por leitura) executando as 4 funções de ponta a ponta em uma
-- transação com ROLLBACK, exercitando deliberadamente cada uma dessas
-- linhas (ver passo de validação abaixo, que reproduz o mesmo tipo de teste
-- para reserve_gateway_usage_v1).
--
-- Esta migration NÃO é aplicada remotamente por este processo — apenas
-- criada e validada localmente/via dry-run. Quem for aplicá-la deve rodar
-- o arquivo inteiro como um único script (Supabase SQL Editor já o faz em
-- uma única transação); qualquer falha de validação ou drift detectado
-- aborta a transação inteira, então a correção da função só entra em
-- vigor se a validação passar.
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

  create temp table if not exists _migration_030000_snapshot (k text primary key, v text);
  delete from _migration_030000_snapshot;
  insert into _migration_030000_snapshot values
    ('runtime_controls_hash', v_runtime_controls_hash),
    ('pricing_hash', v_pricing_hash),
    ('counts', v_counts::text);
end $$;

-- ── Fix: CREATE OR REPLACE reserve_gateway_usage_v1 ─────────────────────────
-- Corpo idêntico ao atualmente aplicado (migration 20260718020000), com a
-- ÚNICA mudança sendo a linha do ON CONFLICT, marcada abaixo com "FIX:".
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

    -- FIX: was "ON CONFLICT (reservation_id, budget_bucket_id)" — ambiguous
    -- against this function's own "reservation_id" OUT parameter/implicit
    -- variable. Real constraint name from the catalog (never invented):
    -- uq_agrbl_reservation_bucket UNIQUE (reservation_id, budget_bucket_id).
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

-- ── Validation: exercise EXACTLY the path that failed (non-empty          ──
-- ── p_budget_scopes), with a synthetic future-dated budget scope so it    ──
-- ── never collides with real data. Aborts the whole migration (RAISE      ──
-- ── EXCEPTION rolls back the transaction, including the function fix      ──
-- ── above) if any expectation fails.                                      ──
do $$
declare
  v_feature_key        text := 'writing.correct'; -- real, pre-existing ai_features row — never invented
  v_scope_key           text := '__migration_030000_synthetic_scope__';
  v_idem_key             text := '__migration_030000_synthetic_reservation__';
  v_period_start          timestamptz := date_trunc('month', now() + interval '50 years');
  v_period_end            timestamptz := v_period_start + interval '1 month';
  v_call1                 record;
  v_call2                 record;
  v_reservation_count     integer;
  v_link_count            integer;
  v_link_cost             numeric;
  v_bucket_reserved_cost  numeric;
begin
  -- First reservation — must exercise the previously-failing INSERT path.
  select * into v_call1 from public.reserve_gateway_usage_v1(
    v_idem_key, null, null,
    v_feature_key, 'openai', 'gpt-test',
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'scope_type', 'global', 'scope_key', v_scope_key,
      'period_type', 'month', 'period_start', v_period_start, 'period_end', v_period_end,
      'limit_usd', 100
    )),
    1.5, 60
  );

  IF v_call1.status IS DISTINCT FROM 'pending' OR v_call1.reservation_id IS NULL THEN
    RAISE EXCEPTION 'validation failed: first reservation did not return pending/reservation_id (got status=%, id=%)', v_call1.status, v_call1.reservation_id;
  END IF;

  -- Second call, SAME idempotency key — must return the identical reservation.
  select * into v_call2 from public.reserve_gateway_usage_v1(
    v_idem_key, null, null,
    v_feature_key, 'openai', 'gpt-test',
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'scope_type', 'global', 'scope_key', v_scope_key,
      'period_type', 'month', 'period_start', v_period_start, 'period_end', v_period_end,
      'limit_usd', 100
    )),
    1.5, 60
  );

  IF v_call2.reservation_id IS DISTINCT FROM v_call1.reservation_id OR v_call2.status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'validation failed: idempotent retry did not return the same reservation (first=%, second=%)', v_call1.reservation_id, v_call2.reservation_id;
  END IF;

  SELECT count(*) INTO v_reservation_count FROM public.usage_reservations WHERE idempotency_key = v_idem_key;
  IF v_reservation_count != 1 THEN
    RAISE EXCEPTION 'validation failed: expected exactly 1 usage_reservations row, found %', v_reservation_count;
  END IF;

  SELECT count(*), sum(l.reserved_cost_usd) INTO v_link_count, v_link_cost
    FROM public.ai_gateway_reservation_budget_links l
    JOIN public.usage_reservations r ON r.id = l.reservation_id
    WHERE r.idempotency_key = v_idem_key;
  IF v_link_count != 1 THEN
    RAISE EXCEPTION 'validation failed: expected exactly 1 ai_gateway_reservation_budget_links row, found %', v_link_count;
  END IF;
  IF v_link_cost IS DISTINCT FROM 1.5 THEN
    RAISE EXCEPTION 'validation failed: link reserved_cost_usd expected 1.5, got %', v_link_cost;
  END IF;

  SELECT reserved_cost_usd INTO v_bucket_reserved_cost
    FROM public.ai_gateway_budget_buckets WHERE scope_type = 'global' AND scope_key = v_scope_key;
  IF v_bucket_reserved_cost IS DISTINCT FROM 1.5 THEN
    RAISE EXCEPTION 'validation failed: bucket reserved_cost_usd expected 1.5, got %', v_bucket_reserved_cost;
  END IF;

  -- Clean up every synthetic row created by this validation, before COMMIT.
  DELETE FROM public.ai_gateway_reservation_budget_links
    WHERE reservation_id IN (SELECT id FROM public.usage_reservations WHERE idempotency_key = v_idem_key);
  DELETE FROM public.usage_reservation_items
    WHERE reservation_id IN (SELECT id FROM public.usage_reservations WHERE idempotency_key = v_idem_key);
  DELETE FROM public.usage_reservations WHERE idempotency_key = v_idem_key;
  DELETE FROM public.ai_gateway_budget_buckets WHERE scope_type = 'global' AND scope_key = v_scope_key;

  RAISE NOTICE '[migration 030000] validation passed: reservation_id=%, link_cost=%, bucket_cost=%', v_call1.reservation_id, v_link_cost, v_bucket_reserved_cost;
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
  select v into v_runtime_controls_hash_before from _migration_030000_snapshot where k = 'runtime_controls_hash';
  select v into v_pricing_hash_before          from _migration_030000_snapshot where k = 'pricing_hash';
  select v::jsonb into v_counts_before         from _migration_030000_snapshot where k = 'counts';

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

  DROP TABLE _migration_030000_snapshot;
  RAISE NOTICE '[migration 030000] snapshot check passed — no drift in ai_runtime_controls, provider_pricing, or consumption tables';
end $$;
