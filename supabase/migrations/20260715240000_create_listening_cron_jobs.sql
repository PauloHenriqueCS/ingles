-- Listening cron jobs: ensure inventory, dispatch queue, repair stuck jobs.
-- Uses pg_cron + pg_net with secrets read from Supabase Vault at runtime.
--
-- Required Vault secrets (apply once via SQL Editor, NOT committed to git):
--   SELECT vault.create_secret('<CRON_SECRET>', 'cron_secret', 'Internal API bearer token');
--   SELECT vault.create_secret('https://ingles-lemon.vercel.app', 'app_base_url', 'Production URL');

-- ─── Enable pg_net (async HTTP calls from the database) ───────────────────────

CREATE EXTENSION IF NOT EXISTS pg_net;

-- ─── Function: listening_cron_ensure_inventory ───────────────────────────────
-- Runs daily at 06:00 UTC (03:00 America/Sao_Paulo).
-- POSTs to /api/internal/listening/supply to fill episode slots below target.

CREATE OR REPLACE FUNCTION public.listening_cron_ensure_inventory()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_secret TEXT;
  v_url    TEXT;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret'  LIMIT 1;
    SELECT decrypted_secret INTO v_url    FROM vault.decrypted_secrets WHERE name = 'app_base_url' LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'listening_cron_ensure_inventory: vault read failed: %', SQLERRM;
    RETURN;
  END;

  IF v_secret IS NULL OR v_url IS NULL THEN
    RAISE WARNING 'listening_cron_ensure_inventory: vault secrets missing (cron_secret or app_base_url)';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     := v_url || '/api/internal/listening/supply',
    headers := jsonb_build_object(
                 'Authorization', 'Bearer ' || v_secret,
                 'Content-Type',  'application/json'
               ),
    body    := '{"action":"generate"}'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.listening_cron_ensure_inventory() FROM PUBLIC;

-- ─── Function: listening_cron_dispatch_jobs ──────────────────────────────────
-- Runs every minute.
-- GETs /api/internal/listening/jobs/dispatch to claim and process queue jobs.

CREATE OR REPLACE FUNCTION public.listening_cron_dispatch_jobs()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_secret TEXT;
  v_url    TEXT;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret'  LIMIT 1;
    SELECT decrypted_secret INTO v_url    FROM vault.decrypted_secrets WHERE name = 'app_base_url' LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'listening_cron_dispatch_jobs: vault read failed: %', SQLERRM;
    RETURN;
  END;

  IF v_secret IS NULL OR v_url IS NULL THEN
    RAISE WARNING 'listening_cron_dispatch_jobs: vault secrets missing (cron_secret or app_base_url)';
    RETURN;
  END IF;

  PERFORM net.http_get(
    url     := v_url || '/api/internal/listening/jobs/dispatch',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.listening_cron_dispatch_jobs() FROM PUBLIC;

-- ─── Function: listening_cron_repair_stuck_jobs ──────────────────────────────
-- Runs every 10 minutes.
-- GETs /api/internal/listening/repair to recover jobs with expired locks.

CREATE OR REPLACE FUNCTION public.listening_cron_repair_stuck_jobs()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_secret TEXT;
  v_url    TEXT;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret'  LIMIT 1;
    SELECT decrypted_secret INTO v_url    FROM vault.decrypted_secrets WHERE name = 'app_base_url' LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'listening_cron_repair_stuck_jobs: vault read failed: %', SQLERRM;
    RETURN;
  END;

  IF v_secret IS NULL OR v_url IS NULL THEN
    RAISE WARNING 'listening_cron_repair_stuck_jobs: vault secrets missing (cron_secret or app_base_url)';
    RETURN;
  END IF;

  PERFORM net.http_get(
    url     := v_url || '/api/internal/listening/repair',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.listening_cron_repair_stuck_jobs() FROM PUBLIC;

-- ─── Schedule cron jobs (idempotent: unschedule then re-add) ─────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'listening-ensure-inventory') THEN
    PERFORM cron.unschedule('listening-ensure-inventory');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'listening-dispatch-jobs') THEN
    PERFORM cron.unschedule('listening-dispatch-jobs');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'listening-repair-stuck-jobs') THEN
    PERFORM cron.unschedule('listening-repair-stuck-jobs');
  END IF;

  -- Daily at 06:00 UTC = 03:00 America/Sao_Paulo
  PERFORM cron.schedule(
    'listening-ensure-inventory',
    '0 6 * * *',
    'SELECT public.listening_cron_ensure_inventory()'
  );

  -- Every minute: process queue jobs
  PERFORM cron.schedule(
    'listening-dispatch-jobs',
    '* * * * *',
    'SELECT public.listening_cron_dispatch_jobs()'
  );

  -- Every 10 minutes: recover stuck jobs
  PERFORM cron.schedule(
    'listening-repair-stuck-jobs',
    '*/10 * * * *',
    'SELECT public.listening_cron_repair_stuck_jobs()'
  );
END;
$$;
