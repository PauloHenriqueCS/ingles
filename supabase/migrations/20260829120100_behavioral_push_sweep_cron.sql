-- =============================================================================
-- MIGRATION: 20260829120100_behavioral_push_sweep_cron
-- Projeto: Orodim
--
-- Aplicada automaticamente por .github/workflows/homologation.yml
-- (supabase db push). NÃO aplicar manualmente no SQL Editor.
--
-- OBJETIVO: ponto de entrada pg_cron → pg_net para o SWEEP de push comportamental.
-- Reutiliza EXATAMENTE o padrão de public.conversation_cron_sweep_stale_sessions
-- e public.alerts_cron_recovery_sweep: lê os secrets do Vault (cron_secret +
-- app_base_url), fal ha fechado se faltarem, e faz um GET autenticado
-- (Authorization: Bearer) para o dispatcher consolidado — SEM criar uma nova
-- Serverless Function na Vercel (o projeto está em 12/12 no plano Hobby).
--
-- REGRA DE PRODUTO: avaliar ~20:00 America/Sao_Paulo. O horário/janela é imposto
-- pelo HANDLER (api/_push/behavioralPushSweep) e pela idempotência por
-- (user_id, local_date) — não por acertar o segundo exato. pg_cron trabalha em
-- UTC; São Paulo é UTC-3 fixo (sem horário de verão desde 2019), então 23:00 UTC
-- ≈ 20:00 SP. Agendar algumas execuções dentro da janela é seguro: re-execuções
-- no mesmo dia não duplicam (ON CONFLICT no claim).
--
-- ESCOPO: puramente aditivo — uma função SECURITY DEFINER. NÃO auto-agenda
-- (mesma convenção deliberada do baseline/operational_alerts): a ativação é um
-- passo manual único no SQL Editor de cada ambiente (ver comentário abaixo).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.behavioral_push_cron_sweep()
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
DECLARE
  v_secret text;
  v_url    text;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret'  LIMIT 1;
    SELECT decrypted_secret INTO v_url    FROM vault.decrypted_secrets WHERE name = 'app_base_url' LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'behavioral_push_cron_sweep: vault read failed: %', SQLERRM;
    RETURN;
  END;

  IF v_secret IS NULL OR v_url IS NULL THEN
    RAISE WARNING 'behavioral_push_cron_sweep: vault secrets missing (cron_secret or app_base_url)';
    RETURN;
  END IF;

  PERFORM net.http_get(
    url     := v_url || '/api/internal/listening/behavioral-push-sweep',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.behavioral_push_cron_sweep() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.behavioral_push_cron_sweep() FROM anon;
REVOKE ALL ON FUNCTION public.behavioral_push_cron_sweep() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.behavioral_push_cron_sweep() TO service_role;

-- ── Ativação (passo manual único por ambiente, no SQL Editor) ────────────────
-- Requer pg_cron + pg_net habilitados e os secrets do Vault já criados
-- (cron_secret == CRON_SECRET da Vercel; app_base_url == URL base do ambiente).
-- Agenda a cada 30 min dentro da janela 23:00–23:59 UTC (≈ 20:00–20:59 SP). O
-- handler só claima usuários quando a hora local SP está na janela; re-execuções
-- não duplicam. Idempotente (unschedule antes de reagendar):
--
--   DO $do$
--   BEGIN
--     PERFORM cron.unschedule('behavioral-push-sweep')
--       WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'behavioral-push-sweep');
--     PERFORM cron.schedule(
--       'behavioral-push-sweep',
--       '0,30 23 * * *',
--       $$SELECT public.behavioral_push_cron_sweep()$$
--     );
--   END;
--   $do$;
