-- =============================================================================
-- MIGRATION: 20260723030000_fix_conversation_sweep_cron_privileges
-- Projeto: Lemon (english learning app)
--
-- Etapa 11 — corrige um gap real introduzido pela própria migration anterior
-- desta entrega (20260723020000_conversation_session_heartbeat_and_hangup_
-- evidence.sql), descoberto pelo Security Advisor do Supabase logo após
-- aplicar: `conversation_cron_sweep_stale_sessions()` só tinha
-- `REVOKE ALL ... FROM PUBLIC` (mesmo padrão das funções de cron de
-- listening já existentes em 20260715240000_create_listening_cron_jobs.sql
-- — que têm o MESMO gap, pré-existente e fora do escopo desta correção).
-- Confirmado por query direta (não só pelo advisor):
--   has_function_privilege('anon', 'public.conversation_cron_sweep_stale_sessions()', 'EXECUTE') = true
--   has_function_privilege('authenticated', ...) = true
-- Ou seja: qualquer usuário anônimo ou autenticado podia chamar a função
-- diretamente via /rest/v1/rpc/conversation_cron_sweep_stale_sessions,
-- disparando uma varredura fora do agendamento do cron. Impacto real
-- limitado (a função não recebe parâmetros e a varredura em si é
-- idempotente/segura de rodar repetidamente), mas é uma superfície de
-- autorização que nunca deveria existir para uma função SECURITY DEFINER
-- de uso interno.
--
-- Também adiciona SET search_path — ausente na declaração original,
-- inconsistente com toda outra função SECURITY DEFINER desta migration e
-- das anteriores (_gateway_audit_database_privileges_v1,
-- record_realtime_hard_control_validation_v1, etc.), e sinalizado por
-- function_search_path_mutable no mesmo advisor scan.
--
-- Esta migration é EXCLUSIVAMENTE corretiva de privilégio: mesma
-- assinatura, mesmo corpo, mesma lógica — apenas adiciona SET search_path
-- e os dois REVOKEs explícitos que faltavam.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.conversation_cron_sweep_stale_sessions()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
REVOKE ALL ON FUNCTION public.conversation_cron_sweep_stale_sessions() FROM anon;
REVOKE ALL ON FUNCTION public.conversation_cron_sweep_stale_sessions() FROM authenticated;

-- =============================================================================
-- VALIDAÇÃO INLINE
-- =============================================================================

DO $$
DECLARE
  v_anon_can_call BOOLEAN;
  v_authenticated_can_call BOOLEAN;
BEGIN
  v_anon_can_call := has_function_privilege('anon', 'public.conversation_cron_sweep_stale_sessions()', 'EXECUTE');
  v_authenticated_can_call := has_function_privilege('authenticated', 'public.conversation_cron_sweep_stale_sessions()', 'EXECUTE');

  IF v_anon_can_call OR v_authenticated_can_call THEN
    RAISE EXCEPTION 'VALIDATION FAILED: conversation_cron_sweep_stale_sessions still callable by anon (%) or authenticated (%)',
      v_anon_can_call, v_authenticated_can_call;
  END IF;

  RAISE NOTICE 'VALIDATION PASSED: conversation_cron_sweep_stale_sessions has search_path pinned and is unreachable by anon/authenticated';
END $$;

COMMIT;

-- =============================================================================
-- FIM DA MIGRATION 20260723030000_fix_conversation_sweep_cron_privileges
-- =============================================================================
