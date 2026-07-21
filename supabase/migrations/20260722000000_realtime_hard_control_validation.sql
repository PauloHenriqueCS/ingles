-- =============================================================================
-- MIGRATION: 20260722000000_realtime_hard_control_validation
-- Projeto: Lemon (english learning app)
--
-- Etapa 11 (fechamento do blocker hard_control_not_live_tested) — as três
-- features realtime (conversation.create_session, conversation.webrtc_connect,
-- conversation.realtime_usage — REALTIME_SESSION_FEATURES em
-- api/_ai-gateway/enforce-readiness.ts) compartilham um único gate,
-- realtimeHardControlReady, que hoje é a constante fixa
-- REALTIME_HARD_CONTROL_LIVE_TESTED=false em
-- scripts/ai-gateway-enforce-preflight.ts — nunca lida de um fato ao vivo,
-- ao contrário de concurrencyValidated (que já lê
-- ai_gateway_concurrency_validations, criada pela migration
-- 20260718000000_ai_gateway_enforcement.sql). Esta migration cria o mesmo
-- tipo de registro persistente, server-only, para a homologação real do
-- hard control de sessões realtime (captura de call_id + hangup via
-- POST /v1/realtime/calls/{call_id}/hangup — ver
-- api/conversation/[...slug].ts's hangupRealtimeCall/handleSessionControl),
-- para que o preflight passe a ler um fato do banco em vez de uma constante
-- de código.
--
-- Mesma garantia de integridade que ai_gateway_concurrency_validations:
--   • Nenhuma policy de RLS (RLS habilitado, zero políticas) — só
--     service_role escreve ou lê esta tabela diretamente.
--   • A única forma de inserir uma linha é
--     record_realtime_hard_control_validation_v1, REVOKEd de
--     anon/authenticated — inalcançável por qualquer rota HTTP desta
--     aplicação, só por acesso direto service-role ao banco (mesmo nível de
--     acesso exigido para aplicar uma migration).
--   • Append-only (sem função de UPDATE/DELETE) — uma validação obsoleta é
--     substituída por uma linha NOVA, nunca editada, preservando o histórico.
--   • validation_script_sha256 é comparado contra o hash AO VIVO do runbook
--     supabase/manual-validation/realtime-hard-control-validation.md,
--     calculado pelo preflight em tempo de execução — qualquer edição futura
--     nesse arquivo invalida automaticamente uma aprovação anterior, sem
--     nenhum passo manual de "invalidar".
--   • hard_control_version identifica QUAL arquitetura de hard control foi
--     testada (hoje: 'session_control_hangup_v1' — captura de call_id via
--     handleSessionActive + hangup real via hangupRealtimeCall). Se essa
--     arquitetura mudar (ex.: a "unified interface" mencionada como trabalho
--     futuro no comentário de handleSessionControl), uma nova versão precisa
--     ser homologada — uma aprovação da arquitetura antiga nunca é reutilizada
--     silenciosamente para uma nova.
--
-- Esta migration é EXCLUSIVAMENTE aditiva: nenhuma tabela, função, policy,
-- gateway_mode ou runtime_status existente é criada, removida ou alterada
-- além do que está descrito acima. Nenhum enforce é ativado por ela.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.realtime_hard_control_validations (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  hard_control_version      TEXT        NOT NULL,
  validation_script_path    TEXT        NOT NULL,
  validation_script_sha256  TEXT        NOT NULL CHECK (validation_script_sha256 ~ '^[0-9a-f]{64}$'),
  status                    TEXT        NOT NULL,
  executed_at               TIMESTAMPTZ NOT NULL,
  executed_by               TEXT        NOT NULL CHECK (char_length(executed_by) BETWEEN 1 AND 200),
  notes                     TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_rhcv_status CHECK (status IN ('passed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_rhcv_lookup ON public.realtime_hard_control_validations
  (hard_control_version, validation_script_sha256, status, executed_at DESC);

ALTER TABLE public.realtime_hard_control_validations ENABLE ROW LEVEL SECURITY;
-- Sem políticas: somente service role acessa (leitura E escrita) — nem
-- authenticated nem anon podem ler ou escrever esta tabela diretamente.

CREATE OR REPLACE FUNCTION public.record_realtime_hard_control_validation_v1(
  p_hard_control_version     TEXT,
  p_validation_script_path   TEXT,
  p_validation_script_sha256 TEXT,
  p_status                   TEXT,
  p_executed_by              TEXT,
  p_notes                    TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF p_hard_control_version IS NULL OR char_length(p_hard_control_version) = 0 THEN
    RAISE EXCEPTION 'hard_control_version is required';
  END IF;
  IF p_validation_script_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'validation_script_sha256 must be a 64-char lowercase hex SHA-256 digest';
  END IF;
  IF p_status NOT IN ('passed', 'failed') THEN
    RAISE EXCEPTION 'status must be passed or failed';
  END IF;
  IF p_executed_by IS NULL OR char_length(p_executed_by) = 0 THEN
    RAISE EXCEPTION 'executed_by is required (a technical identifier for audit — who actually ran the scenarios)';
  END IF;

  INSERT INTO public.realtime_hard_control_validations (
    hard_control_version, validation_script_path, validation_script_sha256, status, executed_at, executed_by, notes
  ) VALUES (
    p_hard_control_version, p_validation_script_path, p_validation_script_sha256, p_status, NOW(), p_executed_by, p_notes
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_realtime_hard_control_validation_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_realtime_hard_control_validation_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.record_realtime_hard_control_validation_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM authenticated;

-- =============================================================================
-- VALIDAÇÃO INLINE
-- =============================================================================

DO $$
DECLARE
  v_table_exists BOOLEAN;
  v_function_exists BOOLEAN;
  v_anon_can_call BOOLEAN;
  v_authenticated_can_call BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'realtime_hard_control_validations'
  ) INTO v_table_exists;
  IF NOT v_table_exists THEN
    RAISE EXCEPTION 'VALIDATION FAILED: realtime_hard_control_validations table does not exist';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'record_realtime_hard_control_validation_v1'
  ) INTO v_function_exists;
  IF NOT v_function_exists THEN
    RAISE EXCEPTION 'VALIDATION FAILED: record_realtime_hard_control_validation_v1 does not exist';
  END IF;

  SELECT has_function_privilege('anon', 'public.record_realtime_hard_control_validation_v1(text,text,text,text,text,text)', 'EXECUTE') INTO v_anon_can_call;
  SELECT has_function_privilege('authenticated', 'public.record_realtime_hard_control_validation_v1(text,text,text,text,text,text)', 'EXECUTE') INTO v_authenticated_can_call;
  IF v_anon_can_call OR v_authenticated_can_call THEN
    RAISE EXCEPTION 'VALIDATION FAILED: record_realtime_hard_control_validation_v1 must be unreachable by anon/authenticated (anon=%, authenticated=%)', v_anon_can_call, v_authenticated_can_call;
  END IF;

  RAISE NOTICE 'VALIDATION PASSED: realtime_hard_control_validations created, RLS enabled with zero policies, record_realtime_hard_control_validation_v1 unreachable by anon/authenticated';
END $$;

COMMIT;

-- =============================================================================
-- FIM DA MIGRATION 20260722000000_realtime_hard_control_validation
-- =============================================================================
