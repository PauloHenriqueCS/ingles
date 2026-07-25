-- =============================================================================
-- MIGRATION: 20260723020000_conversation_session_heartbeat_and_hangup_evidence
-- Projeto: Lemon (english learning app)
--
-- Etapa 11 — endurece o ciclo de vida da sessão realtime
-- (conversation.webrtc_connect) para nunca deixar sessão, autorização ou
-- reserva órfã quando o cliente simplesmente desaparece (aba fechada,
-- crash, perda de conexão) sem passar por nenhum dos caminhos cooperativos
-- já existentes (session-end / session-failed / session-complete /
-- session-control). Hoje nenhum desses caminhos é acionado quando não há
-- mais ninguém do lado do cliente para acioná-los — a linha fica presa em
-- 'active'/'authorized' para sempre.
--
--   1. ai_provider_sessions ganha last_heartbeat_at — renovado por
--      handleSessionActive (primeira renovação) e por CADA poll de
--      handleSessionControl (a cada ~5s enquanto o cliente está vivo — ver
--      api/conversation/[...slug].ts). Esse poll periódico É o heartbeat;
--      esta coluna só o torna persistente e consultável.
--   2. ai_provider_sessions ganha hangup_status/hangup_at/
--      hangup_http_status — o resultado REAL do hangup contra a API da
--      OpenAI (POST /v1/realtime/calls/{call_id}/hangup) passa a ser
--      persistido (api/_realtime-hangup.ts's hangupAndPersist), nunca mais
--      descartado silenciosamente como antes.
--   3. Um índice parcial dá suporte eficiente à varredura periódica
--      (api/internal/listening/[...slug].ts's handleConversationSweep,
--      registrada abaixo via pg_cron a cada minuto — mesmo padrão de
--      pg_net + Vault já usado por
--      20260715240000_create_listening_cron_jobs.sql, reutilizando os
--      MESMOS secrets cron_secret/app_base_url, nenhum novo secret
--      necessário).
--
-- Esta migration é EXCLUSIVAMENTE aditiva: nenhuma coluna existente é
-- alterada ou removida, nenhum dado é apagado, nenhum gateway_mode ou
-- runtime_status é tocado, nenhum enforce é ativado.
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 1: novas colunas em ai_provider_sessions
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.ai_provider_sessions
  ADD COLUMN IF NOT EXISTS last_heartbeat_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS hangup_status       TEXT NOT NULL DEFAULT 'not_attempted',
  ADD COLUMN IF NOT EXISTS hangup_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS hangup_http_status  INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'ai_provider_sessions' AND constraint_name = 'chk_aps_hangup_status'
  ) THEN
    ALTER TABLE public.ai_provider_sessions
      ADD CONSTRAINT chk_aps_hangup_status CHECK (hangup_status IN ('not_attempted', 'ok', 'failed'));
  END IF;
END $$;

-- Suporta as duas queries de handleConversationSweep: sessões 'active' com
-- heartbeat velho, e sessões 'authorized'/'connecting' com autorização
-- vencida. Parcial (só as 3 status não-terminais) — mantém o índice
-- minúsculo mesmo com o histórico completo de sessões crescendo.
CREATE INDEX IF NOT EXISTS idx_aps_sweep_candidates
  ON public.ai_provider_sessions (feature_key, status, last_heartbeat_at, authorization_expires_at)
  WHERE status IN ('active', 'authorized', 'connecting');

-- =============================================================================
-- VALIDAÇÃO INLINE — colunas/índice/constraint existem com a forma esperada.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ai_provider_sessions' AND column_name = 'last_heartbeat_at'
  ) THEN
    RAISE EXCEPTION 'VALIDATION FAILED: ai_provider_sessions.last_heartbeat_at does not exist';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ai_provider_sessions' AND column_name = 'hangup_status'
  ) THEN
    RAISE EXCEPTION 'VALIDATION FAILED: ai_provider_sessions.hangup_status does not exist';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_aps_sweep_candidates'
  ) THEN
    RAISE EXCEPTION 'VALIDATION FAILED: idx_aps_sweep_candidates was not created';
  END IF;

  -- hangup_status CHECK actually rejects an invalid value (self-test —
  -- inserted and rolled back within this same transaction, never committed).
  BEGIN
    INSERT INTO public.ai_provider_sessions (feature_key, provider, status, hangup_status)
    VALUES ('conversation.webrtc_connect', 'openai', 'expired', 'not_a_real_status');
    RAISE EXCEPTION 'SELF-TEST FAILED: hangup_status CHECK constraint did not reject an invalid value';
  EXCEPTION
    WHEN check_violation THEN NULL; -- expected
  END;

  RAISE NOTICE 'VALIDATION PASSED: ai_provider_sessions has last_heartbeat_at/hangup_status/hangup_at/hangup_http_status, idx_aps_sweep_candidates exists, hangup_status CHECK constraint verified';
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 2: cron job — varredura a cada minuto
-- ─────────────────────────────────────────────────────────────────────────────
-- Reaproveita os secrets do Vault já criados para os cron jobs de listening
-- (cron_secret, app_base_url — ver 20260715240000_create_listening_cron_jobs.sql).
-- Nenhum secret novo é necessário: o mesmo CRON_SECRET autentica todo
-- endpoint /api/internal/*.

CREATE OR REPLACE FUNCTION public.conversation_cron_sweep_stale_sessions()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_secret TEXT;
  v_url    TEXT;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret'  LIMIT 1;
    SELECT decrypted_secret INTO v_url    FROM vault.decrypted_secrets WHERE name = 'app_base_url' LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'conversation_cron_sweep_stale_sessions: vault read failed: %', SQLERRM;
    RETURN;
  END;

  IF v_secret IS NULL OR v_url IS NULL THEN
    RAISE WARNING 'conversation_cron_sweep_stale_sessions: vault secrets missing (cron_secret or app_base_url)';
    RETURN;
  END IF;

  PERFORM net.http_get(
    url     := v_url || '/api/internal/listening/conversation-sweep',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.conversation_cron_sweep_stale_sessions() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'conversation-sweep-stale-sessions') THEN
    PERFORM cron.unschedule('conversation-sweep-stale-sessions');
  END IF;

  -- Every minute — same cadence as listening-dispatch-jobs. A session's
  -- heartbeat window (REALTIME_HEARTBEAT_STALE_SECONDS, 60s — see
  -- api/_realtime-constants.ts) is short enough that a 1-minute sweep tick
  -- closes an abandoned session within roughly one extra minute of it
  -- actually going stale, never hours.
  PERFORM cron.schedule(
    'conversation-sweep-stale-sessions',
    '* * * * *',
    'SELECT public.conversation_cron_sweep_stale_sessions()'
  );
END;
$$;

COMMIT;

-- =============================================================================
-- FIM DA MIGRATION 20260723020000_conversation_session_heartbeat_and_hangup_evidence
-- =============================================================================
