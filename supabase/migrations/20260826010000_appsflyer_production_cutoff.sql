-- AppsFlyer Phase 2 — PRODUCTION cutoff.
--
-- The base migration (20260825120000) baked a HOMOLOGATION cutoff
-- (2026-08-25 00:00:00+00). That value is correct for the homolog environment
-- and its already-applied migration is left untouched (non-destructive,
-- reproducible, identical across branches). For PRODUCTION the cutoff must be the
-- real prod rollout instant so that:
--   * pre-existing prod users never fire af_complete_registration retroactively;
--   * pre-existing prod users with historical activity never fire
--     first_activity_completed;
--   * only genuinely new users, created AFTER the prod rollout, enter those events.
--
-- Solution: centralize the cutoff in one immutable function and CREATE OR REPLACE
-- the two claim functions to read it (no table edit, no destructive change). This
-- migration ships ONLY on main (production); homolog keeps its original cutoff.
-- To move the boundary later, replace only appsflyer_feature_cutoff().

CREATE OR REPLACE FUNCTION public.appsflyer_feature_cutoff()
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
AS $$
  -- Production rollout boundary (just after this promotion's prod deploy).
  SELECT TIMESTAMPTZ '2026-08-26 01:00:00+00';
$$;

-- Registration: identical logic, cutoff now sourced from appsflyer_feature_cutoff().
CREATE OR REPLACE FUNCTION public.claim_appsflyer_registration()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_created timestamptz;
BEGIN
  IF v_uid IS NULL THEN RETURN false; END IF;
  SELECT created_at INTO v_created FROM auth.users WHERE id = v_uid;
  IF v_created IS NULL OR v_created < public.appsflyer_feature_cutoff() THEN
    RETURN false;
  END IF;
  RETURN public._claim_appsflyer_slot(v_uid, 'registration', DATE '0001-01-01');
END;
$$;

-- Activity events: identical logic, pre-cutoff history check now sourced from
-- appsflyer_feature_cutoff().
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
  v_uid      uuid := auth.uid();
  v_cutoff   timestamptz := public.appsflyer_feature_cutoff();
  v_sp_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_created  timestamptz;
  v_has_pre  boolean;
BEGIN
  first_activity := false;
  learning_day := false;
  days_since_registration := NULL;

  IF v_uid IS NULL
     OR p_activity_type IS NULL
     OR p_activity_type NOT IN ('writing', 'pronunciation', 'listening', 'review', 'conversation') THEN
    RETURN NEXT; RETURN;
  END IF;

  IF public.appsflyer_user_has_ever_paid(v_uid) THEN
    RETURN NEXT; RETURN;
  END IF;

  SELECT created_at INTO v_created FROM auth.users WHERE id = v_uid;
  IF v_created IS NOT NULL THEN
    days_since_registration := GREATEST(
      0, (v_sp_today - (v_created AT TIME ZONE 'America/Sao_Paulo')::date)
    );
  END IF;

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

    IF v_has_pre THEN
      INSERT INTO public.appsflyer_events (user_id, event_key, event_date, status, fired, last_attempt_at)
      VALUES (v_uid, 'first_activity', DATE '0001-01-01', 'sent', false, now())
      ON CONFLICT (user_id, event_key, event_date) DO NOTHING;
      first_activity := false;
    ELSE
      first_activity := public._claim_appsflyer_slot(v_uid, 'first_activity', DATE '0001-01-01');
    END IF;
  ELSE
    first_activity := public._claim_appsflyer_slot(v_uid, 'first_activity', DATE '0001-01-01');
  END IF;

  learning_day := public._claim_appsflyer_slot(v_uid, 'learning_day', v_sp_today);
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_appsflyer_registration() TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_appsflyer_activity_events(text) TO authenticated;
