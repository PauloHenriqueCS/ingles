-- AppsFlyer Phase 2 — delivery state so a claim does NOT consume a one-shot when
-- the native logEvent then fails. Two-phase, minimal (no queue/event-bus):
--   * A claim now marks the slot 'pending' with a lease (last_attempt_at).
--   * The client calls mark_appsflyer_event_sent ONLY after logAppsFlyerEvent
--     succeeds → the slot flips 'sent' (delivered, never fires again).
--   * A 'pending' slot whose lease has expired (delivery failed / app killed) may
--     be re-claimed for a retry. The re-claim is a single conditional UPDATE, so
--     two devices/sessions never both fire a still-fresh pending slot (no normal
--     duplication); a 'sent' slot blocks forever (lifetime / per-day idempotency).
-- Amends 20260825120000 (already applied) — never edits it.

ALTER TABLE public.appsflyer_events
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'sent'
    CHECK (status IN ('pending', 'sent')),
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz NOT NULL DEFAULT now();
-- Any rows that predate this column keep the old "claimed = done" meaning ('sent').

-- Internal claim primitive. Returns true to EXACTLY ONE caller when the slot is
-- newly created OR an existing 'pending' slot's lease (2 min) has expired
-- (re-claim for retry); false when already 'sent' or a fresh 'pending' attempt is
-- still in flight. Concurrency-safe via the conditional ON CONFLICT DO UPDATE.
CREATE OR REPLACE FUNCTION public._claim_appsflyer_slot(
  p_uid uuid, p_event_key text, p_event_date date
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.appsflyer_events (user_id, event_key, event_date, status, last_attempt_at)
  VALUES (p_uid, p_event_key, p_event_date, 'pending', now())
  ON CONFLICT (user_id, event_key, event_date) DO UPDATE
    SET last_attempt_at = now()
    WHERE public.appsflyer_events.status = 'pending'
      AND public.appsflyer_events.last_attempt_at < now() - interval '2 minutes';
  RETURN FOUND;  -- true iff inserted OR a stale-pending slot was re-leased
END;
$$;
REVOKE ALL ON FUNCTION public._claim_appsflyer_slot(uuid, text, date) FROM anon, authenticated;

-- Registration: unchanged gating (new account only, past the feature cutoff), now
-- returning a leased 'pending' claim instead of consuming the slot outright.
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
  IF v_created IS NULL OR v_created < TIMESTAMPTZ '2026-08-25 00:00:00+00' THEN
    RETURN false;
  END IF;
  RETURN public._claim_appsflyer_slot(v_uid, 'registration', DATE '0001-01-01');
END;
$$;

-- Activity events: same decisions (first-activity eligibility via pre-cutoff
-- history, ever-paid stop, per-SP-day), now leased. A pre-existing active user is
-- permanently suppressed (a 'sent' slot, never fires, never retries); an eligible
-- user gets a 'pending' slot that fires and can retry until delivered.
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
  v_cutoff   timestamptz := TIMESTAMPTZ '2026-08-25 00:00:00+00';
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
      -- Permanent suppression: a delivered, never-fired slot.
      INSERT INTO public.appsflyer_events (user_id, event_key, event_date, status, fired, last_attempt_at)
      VALUES (v_uid, 'first_activity', DATE '0001-01-01', 'sent', false, now())
      ON CONFLICT (user_id, event_key, event_date) DO NOTHING;
      first_activity := false;
    ELSE
      first_activity := public._claim_appsflyer_slot(v_uid, 'first_activity', DATE '0001-01-01');
    END IF;
  ELSE
    -- Slot exists: fire only if it is a stale 'pending' worth retrying (never
    -- recompute the pre-cutoff history, never re-fire a 'sent'/suppressed slot).
    first_activity := public._claim_appsflyer_slot(v_uid, 'first_activity', DATE '0001-01-01');
  END IF;

  learning_day := public._claim_appsflyer_slot(v_uid, 'learning_day', v_sp_today);
  RETURN NEXT;
END;
$$;

-- Mark a claimed slot delivered — called by the client ONLY after logAppsFlyerEvent
-- succeeded. Idempotent; the SP date for learning_day is recomputed server-side.
CREATE OR REPLACE FUNCTION public.mark_appsflyer_event_sent(p_event_key text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_date date := CASE WHEN p_event_key = 'learning_day'
    THEN (now() AT TIME ZONE 'America/Sao_Paulo')::date
    ELSE DATE '0001-01-01' END;
BEGIN
  IF v_uid IS NULL
     OR p_event_key NOT IN ('registration', 'first_activity', 'learning_day') THEN
    RETURN;
  END IF;
  UPDATE public.appsflyer_events SET status = 'sent'
  WHERE user_id = v_uid AND event_key = p_event_key AND event_date = v_date AND status = 'pending';
END;
$$;

REVOKE ALL ON FUNCTION public.mark_appsflyer_event_sent(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.claim_appsflyer_registration() TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_appsflyer_activity_events(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_appsflyer_event_sent(text) TO authenticated;
