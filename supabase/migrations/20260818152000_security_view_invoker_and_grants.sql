-- ============================================================================
-- Security hardening — privileged view must not bypass RLS, and is not client-
-- facing anyway.
--
-- listening_questions_public is a SECURITY DEFINER-style view (advisor:
-- security_definer_view) over listening_questions (RLS enabled, ZERO policies =
-- service-role only). Its ONLY reader is the server-side publication service
-- (build-public-listening-episode.ts, service-role client), never the browser.
--
-- Fix: make it security_invoker (so it respects the caller's RLS instead of the
-- owner's — the service-role caller still reads it via bypassrls, clients get
-- nothing) and revoke the pointless anon/authenticated grants. Answer-key
-- columns were never in the projection; this keeps that and removes the
-- owner-privilege bypass the advisor flagged. Idempotent.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'listening_questions_public' AND c.relkind = 'v'
  ) THEN
    EXECUTE 'ALTER VIEW public.listening_questions_public SET (security_invoker = on)';
    EXECUTE 'REVOKE ALL ON public.listening_questions_public FROM anon';
    EXECUTE 'REVOKE ALL ON public.listening_questions_public FROM authenticated';
    EXECUTE 'GRANT SELECT ON public.listening_questions_public TO service_role';
  END IF;
END$$;
