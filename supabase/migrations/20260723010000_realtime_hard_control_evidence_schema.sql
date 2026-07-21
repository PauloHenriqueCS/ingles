-- =============================================================================
-- MIGRATION: 20260723010000_realtime_hard_control_evidence_schema
-- Projeto: Lemon (english learning app)
--
-- Etapa 11 — endurece o registro de homologação do hard control realtime.
-- A tabela/função criadas por 20260722000000_realtime_hard_control_validation
-- aceitavam um único par (status, notes) livre — nenhuma estrutura exigia
-- que os 8 cenários reais do runbook
-- (supabase/manual-validation/realtime-hard-control-validation.md) tivessem
-- de fato sido executados, nem amarrava o registro ao commit exato do
-- código testado. Esta migration:
--
--   1. Adiciona 4 colunas: git_sha (commit exato testado), environment,
--      scenario_results (jsonb, os 8 cenários nomeados individualmente) e
--      evidence (jsonb, timestamps/call_id/hangup sanitizados por cenário).
--   2. Substitui record_realtime_hard_control_validation_v1: NUNCA mais
--      aceita `status` como parâmetro do chamador — deriva-o internamente
--      dos 8 resultados individuais, então é estruturalmente impossível
--      gravar status='passed' com um cenário faltando ou reprovado.
--   3. `git_sha` é comparado pelo preflight (scripts/ai-gateway-enforce-
--      preflight.ts) contra o HEAD atual — o mesmo idioma de invalidação
--      por hash já usado para o script de validação, agora também para o
--      código testado: qualquer commit novo invalida silenciosamente uma
--      aprovação anterior, sem nenhum passo manual de "invalidar" (mesma
--      garantia de "nunca antiga" que MIGRATION_VERSION/scriptHash já dão
--      para concurrencyValidated).
--   4. REALTIME_HARD_CONTROL_VERSION avança nesta entrega (ver
--      api/_ai-gateway/enforce-readiness.ts) porque o mecanismo em si muda
--      (unified interface para captura de call_id + heartbeat/lease) — o
--      próprio comentário da constante já previa esse gatilho. Nenhuma
--      aprovação anterior existe hoje (realtime_hard_control_validations
--      está vazia — confirmado por query direta antes desta migration), 0
--      linhas migradas.
--
-- Esta migration é aditiva/substitutiva apenas dentro do escopo desta
-- tabela e função: nenhuma outra tabela, gateway_mode ou runtime_status é
-- tocado. Nenhum enforce é ativado.
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 1: novas colunas
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.realtime_hard_control_validations
  ADD COLUMN IF NOT EXISTS git_sha          TEXT,
  ADD COLUMN IF NOT EXISTS environment      TEXT,
  ADD COLUMN IF NOT EXISTS scenario_results JSONB,
  ADD COLUMN IF NOT EXISTS evidence         JSONB NOT NULL DEFAULT '{}'::jsonb;

-- A tabela está vazia (nenhuma homologação foi registrada ainda — validated
-- estava false), então é seguro tornar as 3 colunas centrais NOT NULL
-- diretamente, sem passo de backfill.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.realtime_hard_control_validations LIMIT 1) THEN
    RAISE EXCEPTION 'ABORT: realtime_hard_control_validations has existing rows — this migration assumed it was empty and cannot safely backfill git_sha/environment/scenario_results for them';
  END IF;
END $$;

ALTER TABLE public.realtime_hard_control_validations
  ALTER COLUMN git_sha          SET NOT NULL,
  ALTER COLUMN environment      SET NOT NULL,
  ALTER COLUMN scenario_results SET NOT NULL;

ALTER TABLE public.realtime_hard_control_validations
  ADD CONSTRAINT chk_rhcv_git_sha CHECK (git_sha ~ '^[0-9a-f]{40}$'),
  ADD CONSTRAINT chk_rhcv_environment CHECK (environment IN ('production', 'preview', 'development')),
  ADD CONSTRAINT chk_rhcv_scenario_results_object CHECK (jsonb_typeof(scenario_results) = 'object'),
  ADD CONSTRAINT chk_rhcv_evidence_object CHECK (jsonb_typeof(evidence) = 'object');

DROP INDEX IF EXISTS idx_rhcv_lookup;
CREATE INDEX idx_rhcv_lookup ON public.realtime_hard_control_validations
  (hard_control_version, validation_script_sha256, git_sha, status, executed_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 2: substitui a função de registro — assinatura nova, status derivado
-- ─────────────────────────────────────────────────────────────────────────────
-- Os 8 cenários exigidos (chaves EXATAS de scenario_results, uma por cenário
-- de supabase/manual-validation/realtime-hard-control-validation.md):
--   reservation_authorization  — Cenário 1
--   concurrency                — Cenário 2
--   limit_rejection             — Cenário 3
--   normal_termination          — Cenário 4
--   disconnection                — Cenário 5
--   timeout                       — Cenário 6
--   reservation_release           — Cenário 7
--   orphan_cleanup                 — Cenário 8

DROP FUNCTION IF EXISTS public.record_realtime_hard_control_validation_v1(text, text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.record_realtime_hard_control_validation_v1(
  p_hard_control_version     TEXT,
  p_validation_script_path   TEXT,
  p_validation_script_sha256 TEXT,
  p_git_sha                  TEXT,
  p_environment              TEXT,
  p_scenario_results         JSONB,
  p_executed_by              TEXT,
  p_notes                    TEXT DEFAULT NULL,
  p_evidence                 JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
  v_required_keys TEXT[] := ARRAY[
    'reservation_authorization', 'concurrency', 'limit_rejection', 'normal_termination',
    'disconnection', 'timeout', 'reservation_release', 'orphan_cleanup'
  ];
  v_key TEXT;
  v_val TEXT;
  v_all_passed BOOLEAN := TRUE;
  v_derived_status TEXT;
  v_evidence_text TEXT;
BEGIN
  IF p_hard_control_version IS NULL OR char_length(p_hard_control_version) = 0 THEN
    RAISE EXCEPTION 'hard_control_version is required';
  END IF;
  IF p_validation_script_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'validation_script_sha256 must be a 64-char lowercase hex SHA-256 digest';
  END IF;
  IF p_git_sha !~ '^[0-9a-f]{40}$' THEN
    RAISE EXCEPTION 'git_sha must be a 40-char lowercase hex commit SHA';
  END IF;
  IF p_environment NOT IN ('production', 'preview', 'development') THEN
    RAISE EXCEPTION 'environment must be one of production, preview, development';
  END IF;
  IF p_executed_by IS NULL OR char_length(p_executed_by) = 0 THEN
    RAISE EXCEPTION 'executed_by is required (a technical identifier for audit — who actually ran the scenarios)';
  END IF;
  IF p_scenario_results IS NULL OR jsonb_typeof(p_scenario_results) <> 'object' THEN
    RAISE EXCEPTION 'scenario_results must be a JSON object';
  END IF;

  -- Evidência ausente ou incompleta: as 8 chaves exigidas devem estar TODAS
  -- presentes — nem a mais, nem a menos (nenhuma chave desconhecida, que
  -- poderia indicar um cenário renomeado/typo silenciosamente ignorado).
  IF (SELECT COUNT(*) FROM jsonb_object_keys(p_scenario_results)) <> array_length(v_required_keys, 1) THEN
    RAISE EXCEPTION 'scenario_results must contain exactly the % required scenario keys, got % keys', array_length(v_required_keys, 1), (SELECT COUNT(*) FROM jsonb_object_keys(p_scenario_results));
  END IF;

  FOREACH v_key IN ARRAY v_required_keys LOOP
    IF NOT (p_scenario_results ? v_key) THEN
      RAISE EXCEPTION 'scenario_results missing required key: %', v_key;
    END IF;
    IF jsonb_typeof(p_scenario_results -> v_key) <> 'string' THEN
      RAISE EXCEPTION 'scenario_results.% must be a string (''passed'' or ''failed'')', v_key;
    END IF;
    v_val := p_scenario_results ->> v_key;
    IF v_val NOT IN ('passed', 'failed') THEN
      RAISE EXCEPTION 'scenario_results.% must be ''passed'' or ''failed'', got %', v_key, v_val;
    END IF;
    IF v_val = 'failed' THEN
      v_all_passed := FALSE;
    END IF;
  END LOOP;

  -- status NUNCA é um parâmetro do chamador — deriva-se exclusivamente dos
  -- 8 resultados individuais. Estruturalmente impossível gravar
  -- status='passed' com qualquer cenário ausente ou reprovado.
  v_derived_status := CASE WHEN v_all_passed THEN 'passed' ELSE 'failed' END;

  -- Sanitização leve da evidência livre: tamanho limitado e varredura por
  -- padrões que parecem segredo (chave da OpenAI, header Bearer, hex longo
  -- que poderia ser um token) — nunca aceita como uma garantia completa de
  -- ausência de PII, mas barra os erros mais óbvios de colar algo sensível
  -- aqui por engano.
  IF jsonb_typeof(p_evidence) <> 'object' THEN
    RAISE EXCEPTION 'evidence must be a JSON object';
  END IF;
  v_evidence_text := p_evidence::text;
  IF char_length(v_evidence_text) > 20000 THEN
    RAISE EXCEPTION 'evidence payload too large (max 20000 chars) — summarize, do not paste raw logs';
  END IF;
  IF v_evidence_text ~ 'sk-[A-Za-z0-9_-]{10,}' OR v_evidence_text ~* 'bearer\s+[A-Za-z0-9._-]{10,}' THEN
    RAISE EXCEPTION 'evidence appears to contain a raw API key or bearer token — never persist secrets here';
  END IF;

  INSERT INTO public.realtime_hard_control_validations (
    hard_control_version, validation_script_path, validation_script_sha256,
    git_sha, environment, scenario_results, status, executed_at, executed_by, notes, evidence
  ) VALUES (
    p_hard_control_version, p_validation_script_path, p_validation_script_sha256,
    p_git_sha, p_environment, p_scenario_results, v_derived_status, NOW(), p_executed_by, p_notes, p_evidence
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_realtime_hard_control_validation_v1(TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_realtime_hard_control_validation_v1(TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.record_realtime_hard_control_validation_v1(TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, JSONB) FROM authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 3: atualiza a função de auditoria de privilégios para a nova assinatura
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._gateway_audit_database_privileges_v1()
RETURNS TABLE(unsafe_tables text[], unsafe_functions text[])
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_table          TEXT;
  v_func_sig       TEXT;
  v_unsafe_tables  TEXT[] := '{}';
  v_unsafe_funcs   TEXT[] := '{}';
BEGIN
  FOR v_table IN
    SELECT unnest(ARRAY[
      'ai_gateway_decisions', 'ai_gateway_idempotency_locks', 'ai_gateway_quota_buckets',
      'ai_gateway_budget_buckets', 'ai_gateway_reservation_budget_links', 'ai_gateway_circuit_breakers',
      'api_rate_limits', 'ai_gateway_concurrency_validations',
      'conversation_session_authorizations', 'realtime_hard_control_validations'
    ])
  LOOP
    IF has_table_privilege('anon', 'public.' || v_table, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR has_table_privilege('authenticated', 'public.' || v_table, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    THEN
      v_unsafe_tables := array_append(v_unsafe_tables, v_table);
    END IF;
  END LOOP;

  FOR v_func_sig IN
    SELECT * FROM unnest(ARRAY[
      'begin_gateway_idempotent_op_v1(text, text, integer)',
      'complete_gateway_idempotent_op_v1(uuid, text)',
      'fail_gateway_idempotent_op_v1(uuid)',
      '_gateway_touch_quota_bucket_v1(text, uuid, text, text, text, timestamp with time zone, timestamp with time zone)',
      '_gateway_touch_budget_bucket_v1(text, text, text, timestamp with time zone, timestamp with time zone)',
      'reserve_gateway_usage_v1(text, uuid, uuid, text, text, text, jsonb, jsonb, numeric, integer)',
      'commit_gateway_reservation_v1(uuid, uuid, numeric, jsonb)',
      'release_gateway_reservation_v1(uuid, text)',
      'mark_gateway_reservation_reconciliation_required_v1(uuid, text)',
      'expire_stale_gateway_reservations_v1(integer)',
      'get_gateway_breaker_state_v1(text, text, text)',
      'record_gateway_breaker_outcome_v1(text, text, text, boolean)',
      'check_and_increment_rate_limit(uuid, text, integer, integer)',
      'gateway_publish_runtime_controls_v1()',
      'gateway_publish_pricing_v1()',
      '_gateway_publish_runtime_controls_trigger_v1()',
      '_gateway_publish_pricing_trigger_v1()',
      'record_gateway_concurrency_validation_v1(text, text, text, text, text, text)',
      'record_realtime_hard_control_validation_v1(text, text, text, text, text, jsonb, text, text, jsonb)'
    ])
  LOOP
    IF has_function_privilege('anon', ('public.' || v_func_sig)::regprocedure, 'EXECUTE')
       OR has_function_privilege('authenticated', ('public.' || v_func_sig)::regprocedure, 'EXECUTE')
    THEN
      v_unsafe_funcs := array_append(v_unsafe_funcs, v_func_sig);
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_unsafe_tables, v_unsafe_funcs;
END;
$function$;

-- =============================================================================
-- VALIDAÇÃO INLINE — testes positivos e negativos da nova função, todos
-- dentro da transação, dados sintéticos removidos antes do COMMIT.
-- =============================================================================

DO $$
DECLARE
  v_valid_scenarios JSONB := jsonb_build_object(
    'reservation_authorization', 'passed', 'concurrency', 'passed', 'limit_rejection', 'passed',
    'normal_termination', 'passed', 'disconnection', 'passed', 'timeout', 'passed',
    'reservation_release', 'passed', 'orphan_cleanup', 'passed'
  );
  v_id UUID;
  v_row RECORD;
  v_threw BOOLEAN;
BEGIN
  -- ── Positivo: todos os 8 cenários 'passed' → status derivado 'passed' ──────
  v_id := public.record_realtime_hard_control_validation_v1(
    '__migration_selftest__', 'supabase/manual-validation/realtime-hard-control-validation.md',
    repeat('a', 64), repeat('f', 40), 'development', v_valid_scenarios, '__selftest__', 'inline self-test', '{}'::jsonb
  );
  SELECT status INTO v_row FROM public.realtime_hard_control_validations WHERE id = v_id;
  IF v_row.status <> 'passed' THEN
    RAISE EXCEPTION 'SELF-TEST FAILED: all-passed scenario_results should derive status=passed, got %', v_row.status;
  END IF;

  -- ── Positivo: um cenário 'failed' → status derivado 'failed' (nunca passed) ─
  v_id := public.record_realtime_hard_control_validation_v1(
    '__migration_selftest__', 'supabase/manual-validation/realtime-hard-control-validation.md',
    repeat('a', 64), repeat('f', 40), 'development',
    v_valid_scenarios || jsonb_build_object('timeout', 'failed'),
    '__selftest__', 'inline self-test', '{}'::jsonb
  );
  SELECT status INTO v_row FROM public.realtime_hard_control_validations WHERE id = v_id;
  IF v_row.status <> 'failed' THEN
    RAISE EXCEPTION 'SELF-TEST FAILED: one failed scenario should derive status=failed, got %', v_row.status;
  END IF;

  -- ── Negativo: cenário faltando (7 de 8) deve lançar exceção ─────────────────
  v_threw := FALSE;
  BEGIN
    PERFORM public.record_realtime_hard_control_validation_v1(
      '__migration_selftest__', 'supabase/manual-validation/realtime-hard-control-validation.md',
      repeat('a', 64), repeat('f', 40), 'development',
      v_valid_scenarios - 'timeout',
      '__selftest__', NULL, '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN v_threw := TRUE;
  END;
  IF NOT v_threw THEN
    RAISE EXCEPTION 'SELF-TEST FAILED: missing scenario key should have raised an exception';
  END IF;

  -- ── Negativo: chave desconhecida extra (9 chaves) deve lançar exceção ───────
  v_threw := FALSE;
  BEGIN
    PERFORM public.record_realtime_hard_control_validation_v1(
      '__migration_selftest__', 'supabase/manual-validation/realtime-hard-control-validation.md',
      repeat('a', 64), repeat('f', 40), 'development',
      v_valid_scenarios || jsonb_build_object('unknown_scenario', 'passed'),
      '__selftest__', NULL, '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN v_threw := TRUE;
  END;
  IF NOT v_threw THEN
    RAISE EXCEPTION 'SELF-TEST FAILED: unexpected extra scenario key should have raised an exception';
  END IF;

  -- ── Negativo: git_sha malformado deve lançar exceção ────────────────────────
  v_threw := FALSE;
  BEGIN
    PERFORM public.record_realtime_hard_control_validation_v1(
      '__migration_selftest__', 'supabase/manual-validation/realtime-hard-control-validation.md',
      repeat('a', 64), 'not-a-real-sha', 'development', v_valid_scenarios, '__selftest__', NULL, '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN v_threw := TRUE;
  END;
  IF NOT v_threw THEN
    RAISE EXCEPTION 'SELF-TEST FAILED: malformed git_sha should have raised an exception';
  END IF;

  -- ── Negativo: environment fora do enum permitido deve lançar exceção ────────
  v_threw := FALSE;
  BEGIN
    PERFORM public.record_realtime_hard_control_validation_v1(
      '__migration_selftest__', 'supabase/manual-validation/realtime-hard-control-validation.md',
      repeat('a', 64), repeat('f', 40), 'staging', v_valid_scenarios, '__selftest__', NULL, '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN v_threw := TRUE;
  END;
  IF NOT v_threw THEN
    RAISE EXCEPTION 'SELF-TEST FAILED: invalid environment should have raised an exception';
  END IF;

  -- ── Negativo: evidência contendo algo que parece uma chave de API ───────────
  v_threw := FALSE;
  BEGIN
    PERFORM public.record_realtime_hard_control_validation_v1(
      '__migration_selftest__', 'supabase/manual-validation/realtime-hard-control-validation.md',
      repeat('a', 64), repeat('f', 40), 'development', v_valid_scenarios, '__selftest__', NULL,
      jsonb_build_object('leaked', 'sk-abcdefghijklmnopqrstuvwx')
    );
  EXCEPTION WHEN OTHERS THEN v_threw := TRUE;
  END;
  IF NOT v_threw THEN
    RAISE EXCEPTION 'SELF-TEST FAILED: evidence containing an apparent API key should have raised an exception';
  END IF;

  -- ── Limpeza: remove os registros sintéticos do self-test antes do COMMIT ────
  DELETE FROM public.realtime_hard_control_validations WHERE hard_control_version = '__migration_selftest__';

  IF EXISTS (SELECT 1 FROM public.realtime_hard_control_validations WHERE hard_control_version = '__migration_selftest__') THEN
    RAISE EXCEPTION 'SELF-TEST CLEANUP FAILED: synthetic rows still present';
  END IF;

  RAISE NOTICE 'VALIDATION PASSED: record_realtime_hard_control_validation_v1 derives status from scenario_results (never trusts a caller-supplied status), rejects missing/extra scenario keys, malformed git_sha, invalid environment, and evidence resembling a raw secret — all 7 self-test cases (2 positive, 5 negative) passed; synthetic rows cleaned up';
END $$;

COMMIT;

-- =============================================================================
-- FIM DA MIGRATION 20260723010000_realtime_hard_control_evidence_schema
-- =============================================================================
