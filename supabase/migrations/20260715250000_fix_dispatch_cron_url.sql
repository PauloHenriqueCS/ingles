-- Fix listening_cron_dispatch_jobs to call /api/internal/listening/dispatch
-- instead of /api/internal/listening/jobs/dispatch (which returns 404 on Vercel
-- because the catch-all [...slug].ts strips the leading path segment differently
-- than expected when "jobs/" is a sub-path).
--
-- The dispatcher now accepts both 'dispatch' and 'jobs/dispatch' as aliases, but
-- /api/internal/listening/dispatch is the canonical URL going forward.

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
    url     := v_url || '/api/internal/listening/dispatch',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.listening_cron_dispatch_jobs() FROM PUBLIC;
