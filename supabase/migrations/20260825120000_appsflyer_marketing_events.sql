-- AppsFlyer Phase 2 — marketing-funnel event idempotency + immutable "ever paid".
--
-- The AppsFlyer SDK is CLIENT-side (native). To keep the funnel events one-shot
-- and to STOP them after the user's first-ever payment, the decision cannot live
-- in JS/localStorage (must survive reload, logout/login, device switch, and
-- reinstall). This migration centralizes that decision in the DB:
--   * appsflyer_events   — append-only claim ledger; a UNIQUE constraint makes
--                          each one-shot / one-per-day claim atomic & idempotent.
--   * user_billing_facts — write-once first_paid_at (the immutable "ever paid").
--   * three SECURITY DEFINER RPCs the authenticated client calls to (a) claim a
--     one-shot event and (b) learn whether behavioural events are still allowed.
--
-- The client only ever LOGS to AppsFlyer what these RPCs authorize. No PII is
-- stored or returned. Identity everywhere stays the Supabase UUID.

-- ---------------------------------------------------------------------------
-- Feature-ship boundary. Users/activities that existed BEFORE this are never
-- treated as "new" — af_complete_registration and first_activity_completed must
-- never fire retroactively for a pre-existing user. This is a homologation-first
-- ship; when promoting to production, set this to the production deploy instant.
-- ---------------------------------------------------------------------------
-- (baked as a literal inside each function below: '2026-08-25 00:00:00+00')

-- ===========================================================================
-- 1. Claim ledger — one row per (user, event_key, event_date). event_date uses
--    a sentinel ('0001-01-01') for one-per-life events so the UNIQUE constraint
--    and ON CONFLICT work uniformly for both one-shot and per-day claims.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.appsflyer_events (
  user_id    uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  event_key  text NOT NULL CHECK (event_key IN ('registration', 'first_activity', 'learning_day')),
  event_date date NOT NULL DEFAULT DATE '0001-01-01',
  fired      boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appsflyer_events_pkey PRIMARY KEY (user_id, event_key, event_date)
);

ALTER TABLE public.appsflyer_events ENABLE ROW LEVEL SECURITY;
-- No policies: only the SECURITY DEFINER RPCs below (and service_role) touch it.
REVOKE ALL ON public.appsflyer_events FROM anon, authenticated;
GRANT ALL ON public.appsflyer_events TO service_role;

-- ===========================================================================
-- 2. Immutable "ever paid" fact. first_paid_at is write-once (only set when
--    currently NULL) so cancellation/expiry/re-subscription never clears it —
--    "has paid at least once in their life", not "active now". Populated
--    server-side from the RevenueCat reconcile path (fail-closed: honored,
--    non-sandbox-blocked payments only).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.user_billing_facts (
  user_id         uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  first_paid_at   timestamptz,
  first_paid_source text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_billing_facts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_billing_facts FROM anon, authenticated;
GRANT ALL ON public.user_billing_facts TO service_role;

-- Write-once helper used by the server reconcile path. Idempotent: only stamps
-- first_paid_at when it is still NULL; never overwrites an earlier payment.
CREATE OR REPLACE FUNCTION public.mark_user_first_paid(
  p_user_id uuid,
  p_source  text DEFAULT NULL
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.user_billing_facts (user_id, first_paid_at, first_paid_source)
  VALUES (p_user_id, now(), p_source)
  ON CONFLICT (user_id) DO UPDATE
    SET first_paid_at     = COALESCE(public.user_billing_facts.first_paid_at, EXCLUDED.first_paid_at),
        first_paid_source = COALESCE(public.user_billing_facts.first_paid_source, EXCLUDED.first_paid_source),
        updated_at        = now()
  WHERE public.user_billing_facts.first_paid_at IS NULL;
$$;
-- Server-only (called with the service client, passing an explicit user id).
REVOKE ALL ON FUNCTION public.mark_user_first_paid(uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_user_first_paid(uuid, text) TO service_role;

-- Internal: has this user EVER paid? (true once first_paid_at is set, forever.)
CREATE OR REPLACE FUNCTION public.appsflyer_user_has_ever_paid(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_billing_facts
    WHERE user_id = p_user_id AND first_paid_at IS NOT NULL
  );
$$;

-- ===========================================================================
-- 3. Client-callable RPCs (authenticated). All use auth.uid() — the caller can
--    only ever affect their OWN rows; no spoofable user-id parameter.
-- ===========================================================================

-- 3a. af_complete_registration — fire exactly once, for genuinely NEW accounts
--     only (created at/after the feature boundary). Returns true at most once
--     per user, ever (survives reinstall/device switch via the claim row).
CREATE OR REPLACE FUNCTION public.claim_appsflyer_registration()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_created timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RETURN false;
  END IF;

  -- Never retroactive: a pre-existing account (created before the feature
  -- boundary) must never fire registration, even on first app open post-ship.
  SELECT created_at INTO v_created FROM auth.users WHERE id = v_uid;
  IF v_created IS NULL OR v_created < TIMESTAMPTZ '2026-08-25 00:00:00+00' THEN
    RETURN false;
  END IF;

  -- Atomic one-shot claim (idempotent across sessions/devices/reinstalls).
  INSERT INTO public.appsflyer_events (user_id, event_key)
  VALUES (v_uid, 'registration')
  ON CONFLICT (user_id, event_key, event_date) DO NOTHING;

  RETURN FOUND;  -- true only on the first successful insert
END;
$$;

-- 3b. first_activity_completed + learning_day_completed, decided together from
--     ONE call after any genuine activity completion. Both are suppressed once
--     the user has ever paid.
--       first_activity: once in a lifetime, and never for a user who already
--                       had completions before the feature boundary.
--       learning_day:   at most once per America/Sao_Paulo day.
CREATE OR REPLACE FUNCTION public.claim_appsflyer_activity_events(p_activity_type text)
RETURNS TABLE (
  first_activity boolean,
  learning_day boolean,
  days_since_registration integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_uid          uuid := auth.uid();
  v_cutoff       timestamptz := TIMESTAMPTZ '2026-08-25 00:00:00+00';
  v_sp_today     date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_created      timestamptz;
  v_has_pre      boolean;
  v_first_claim  boolean := false;
  v_day_claim    boolean := false;
BEGIN
  first_activity := false;
  learning_day := false;
  days_since_registration := NULL;

  IF v_uid IS NULL
     OR p_activity_type IS NULL
     OR p_activity_type NOT IN ('writing', 'pronunciation', 'listening', 'review', 'conversation') THEN
    RETURN NEXT; RETURN;
  END IF;

  -- Acquisition events stop forever after the first payment.
  IF public.appsflyer_user_has_ever_paid(v_uid) THEN
    RETURN NEXT; RETURN;
  END IF;

  SELECT created_at INTO v_created FROM auth.users WHERE id = v_uid;
  IF v_created IS NOT NULL THEN
    days_since_registration := GREATEST(
      0, (v_sp_today - (v_created AT TIME ZONE 'America/Sao_Paulo')::date)
    );
  END IF;

  -- first_activity: claim once per lifetime. Suppress (but still claim, so we
  -- never re-scan) for users who already had completions before the boundary.
  IF NOT EXISTS (
    SELECT 1 FROM public.appsflyer_events
    WHERE user_id = v_uid AND event_key = 'first_activity'
  ) THEN
    v_has_pre := (
      EXISTS (SELECT 1 FROM public.english_reviews
              WHERE user_id = v_uid AND created_at < v_cutoff)
      OR EXISTS (SELECT 1 FROM public.pronunciation_training_sessions
                 WHERE user_id = v_uid AND status = 'completed' AND completed_at < v_cutoff)
      OR EXISTS (SELECT 1 FROM public.user_listening_assignments
                 WHERE user_id = v_uid AND status = 'completed' AND completed_at < v_cutoff)
      OR EXISTS (SELECT 1 FROM public.review_item_attempts
                 WHERE user_id = v_uid AND created_at < v_cutoff)
      OR EXISTS (SELECT 1 FROM public.conversation_sessions
                 WHERE user_id = v_uid AND created_at < v_cutoff)
    );

    INSERT INTO public.appsflyer_events (user_id, event_key, fired)
    VALUES (v_uid, 'first_activity', NOT v_has_pre)
    ON CONFLICT (user_id, event_key, event_date) DO NOTHING;
    -- FOUND = we won the claim; fire only if the user has no pre-boundary history.
    v_first_claim := FOUND AND NOT v_has_pre;
  END IF;

  -- learning_day: first genuine completion of this SP day.
  INSERT INTO public.appsflyer_events (user_id, event_key, event_date)
  VALUES (v_uid, 'learning_day', v_sp_today)
  ON CONFLICT (user_id, event_key, event_date) DO NOTHING;
  v_day_claim := FOUND;

  first_activity := v_first_claim;
  learning_day := v_day_claim;
  RETURN NEXT;
END;
$$;

-- 3c. Are behavioural marketing events still allowed for this user? (false once
--     they have ever paid.) Used by the client to gate paywall_viewed /
--     af_initiated_checkout, which are not one-shot claims.
CREATE OR REPLACE FUNCTION public.appsflyer_marketing_allowed()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT auth.uid() IS NOT NULL
     AND NOT public.appsflyer_user_has_ever_paid(auth.uid());
$$;

REVOKE ALL ON FUNCTION public.claim_appsflyer_registration() FROM anon;
REVOKE ALL ON FUNCTION public.claim_appsflyer_activity_events(text) FROM anon;
REVOKE ALL ON FUNCTION public.appsflyer_marketing_allowed() FROM anon;
GRANT EXECUTE ON FUNCTION public.claim_appsflyer_registration() TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_appsflyer_activity_events(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.appsflyer_marketing_allowed() TO authenticated;
