-- ============================================================
-- Signup gate: Supabase Auth "Before User Created" hook
-- ============================================================
-- Connects app_config_definitions.signup.registration (owned by the
-- ingles-dashboad repo's Central de Configuração de Produto) to real signup
-- enforcement. supabase.auth.signUp is called directly from the browser with
-- the public anon key (src/components/LoginPage.tsx) — no route in this repo
-- sits in front of it, so a new API route alone would be bypassable by any
-- direct call to Supabase's own Auth REST API with that same anon key. This
-- hook runs inside GoTrue itself, before the auth.users row is created,
-- regardless of caller — the only real enforcement point.
--
-- This migration only CREATES the function. It does not activate it — that
-- requires a manual step in Supabase Dashboard -> Authentication -> Hooks ->
-- "Before User Created", pointing at public.hook_enforce_signup_gate. Not
-- something this migration (or any tool available in this session) can do;
-- Auth Hook activation is a GoTrue project setting, not a database object.
--
-- Fails OPEN on any internal error (RPC unreachable, malformed snapshot,
-- etc.) — a transient config-read failure must never block every signup.
-- Only an explicit signup.registration.enabled = false closes the gate.
--
-- Reads app_get_server_config_snapshot_v1('production') directly: GoTrue is
-- one shared instance across preview and production deployments (they share
-- this same Supabase project), so there is no per-deployment environment to
-- key off inside the hook — 'production' is the only meaningful choice here.

CREATE OR REPLACE FUNCTION public.hook_enforce_signup_gate(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_snapshot jsonb;
  v_signup   jsonb;
  v_enabled  boolean;
  v_starts_at timestamptz;
  v_ends_at   timestamptz;
  v_message  text;
BEGIN
  BEGIN
    v_snapshot := app_get_server_config_snapshot_v1('production');
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'hook_enforce_signup_gate: config read failed, failing open: %', SQLERRM;
    RETURN '{}'::jsonb;
  END;

  -- No published version yet (version_number = 0) → nothing to enforce, allow.
  IF v_snapshot IS NULL OR (v_snapshot->>'version_number')::int = 0 THEN
    RETURN '{}'::jsonb;
  END IF;

  v_signup := v_snapshot->'values'->'signup.registration';
  IF v_signup IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;

  v_enabled := COALESCE((v_signup->>'enabled')::boolean, true);
  IF v_enabled THEN
    RETURN '{}'::jsonb;
  END IF;

  -- enabled = false — but only within the configured window, if one is set.
  BEGIN
    v_starts_at := NULLIF(v_signup->>'startsAt', '')::timestamptz;
    v_ends_at   := NULLIF(v_signup->>'endsAt', '')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    v_starts_at := NULL;
    v_ends_at := NULL;
  END;

  IF v_starts_at IS NOT NULL AND now() < v_starts_at THEN
    RETURN '{}'::jsonb;
  END IF;
  IF v_ends_at IS NOT NULL AND now() > v_ends_at THEN
    RETURN '{}'::jsonb;
  END IF;

  v_message := COALESCE(NULLIF(v_signup->>'closedMessage', ''),
    'Novos cadastros estão temporariamente indisponíveis. Tente novamente em breve.');

  RETURN jsonb_build_object('error', jsonb_build_object('http_code', 400, 'message', v_message));
END;
$$;

GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.hook_enforce_signup_gate(jsonb) TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.hook_enforce_signup_gate(jsonb) FROM PUBLIC, anon, authenticated;
