-- ============================================================================
-- Reclaim an ABANDONED pronunciation-training attempt.
-- ----------------------------------------------------------------------------
-- Observed in production (2026-08-21): /start reserved session
-- fb6a0a65-cc80-4a61-99f4-c983b0b0c6bb at 16:53:11 and the page reloaded before
-- the audio was uploaded, so the client's /fail never ran. The row stayed in
-- 'processing' with a live active_attempt_id forever, and every later attempt
-- got ASSESSMENT_IN_PROGRESS ("Outra análise está em andamento") — the user was
-- locked out of the activity for the rest of the day with no way to recover.
--
-- Any crash, reload, force-quit, tab close or dropped connection between /start
-- and the finish produced this. There was no sweeper and no reclaim path: the
-- ONLY exits from 'processing' were /complete and /fail, both of which need the
-- client that just died.
--
-- Fix: treat a 'processing' row whose attempt_started_at is older than
-- RECLAIM_AFTER as abandoned, and let a NEW attempt take the row over.
--
-- The 6-minute threshold is deliberately longer than any legitimate in-flight
-- assessment can survive: the server-side assessor caps a run at 240 s
-- (MAX_ASSESSMENT_MS in api/_azure-pronunciation.ts) and the Vercel function
-- itself is killed at 300 s. So a row idle for 6 minutes cannot still have a
-- real assessment running behind it.
--
-- QUOTA IS UNCHANGED — this is the important part:
--   * v_consumed counts status IN ('processing','completed'), and a partial
--     unique index allows at most one non-completed row per (user, date). The
--     abandoned row is ALREADY counted as consumed, and reclaiming leaves it in
--     'processing', so the count does not move. The reclaim swaps the attempt id
--     on an already-consumed slot; it never grants an extra analysis and never
--     double-consumes.
--   * The daily-limit check stays exactly where it was — on the
--     text_generated / failed_retryable / failed_final branch, where the row is
--     NOT yet part of v_consumed. Re-checking it on the reclaim branch would
--     wrongly count the row against itself.
--   * complete_/fail_ still gate on active_attempt_id = p_attempt_id, so if a
--     zombie server-side run ever did finish late it would get ATTEMPT_MISMATCH
--     against the reclaimed row instead of corrupting it.
--
-- Idempotent: CREATE OR REPLACE only.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reserve_pronunciation_training_assessment(
  p_user_id         uuid,
  p_practice_date   date,
  p_azure_region    text,
  p_attempt_id      uuid,
  p_effective_limit integer,
  p_unlimited       boolean
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id        UUID;
  v_id             UUID;
  v_status         TEXT;
  v_active_attempt UUID;
  v_generated_text TEXT;
  v_attempt_start  TIMESTAMPTZ;
  v_consumed       INTEGER;
  v_completed      INTEGER;
  -- Longer than the server assessor's 240 s cap and Vercel's 300 s ceiling.
  c_reclaim_after  CONSTANT INTERVAL := INTERVAL '6 minutes';
BEGIN
  v_user_id := p_user_id;
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  IF p_attempt_id IS NULL THEN
    RETURN jsonb_build_object('error', 'INVALID_ATTEMPT_ID');
  END IF;

  SELECT id, status, active_attempt_id, generated_text, attempt_started_at
  INTO   v_id, v_status, v_active_attempt, v_generated_text, v_attempt_start
  FROM   pronunciation_training_sessions
  WHERE  user_id = v_user_id AND practice_date = p_practice_date AND status <> 'completed'
  FOR UPDATE
  LIMIT  1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'TEXT_NOT_GENERATED');
  END IF;

  SELECT count(*) INTO v_consumed
  FROM   pronunciation_training_sessions
  WHERE  user_id = v_user_id AND practice_date = p_practice_date
    AND  status IN ('processing', 'completed');

  SELECT count(*) INTO v_completed
  FROM   pronunciation_training_sessions
  WHERE  user_id = v_user_id AND practice_date = p_practice_date AND status = 'completed';

  CASE v_status
    WHEN 'text_generated', 'failed_retryable', 'failed_final' THEN
      IF NOT COALESCE(p_unlimited, false) AND v_consumed >= COALESCE(p_effective_limit, 0) THEN
        RETURN jsonb_build_object('error', 'DAILY_LIMIT_REACHED', 'sessionId', v_id, 'dailyCompleted', v_completed);
      END IF;

      UPDATE pronunciation_training_sessions
         SET status             = 'processing',
             started_at         = NOW(),
             active_attempt_id  = p_attempt_id,
             attempt_started_at = NOW(),
             azure_region       = p_azure_region,
             error_code         = NULL,
             error_message      = NULL
       WHERE id = v_id;

      RETURN jsonb_build_object('action', 'reserved', 'sessionId', v_id, 'referenceText', v_generated_text, 'dailyCompleted', v_completed);

    WHEN 'processing' THEN
      -- Same attempt retrying: idempotent, unchanged behaviour.
      IF v_active_attempt = p_attempt_id THEN
        RETURN jsonb_build_object('action', 'existing_processing', 'sessionId', v_id, 'referenceText', v_generated_text, 'dailyCompleted', v_completed);
      END IF;

      -- A DIFFERENT attempt, and the current one has been idle past the point
      -- where any real assessment could still be running: the previous attempt
      -- died with the client. Hand the (already-consumed) slot to the new one
      -- instead of locking the user out for the rest of the day.
      IF v_attempt_start IS NULL OR v_attempt_start < NOW() - c_reclaim_after THEN
        UPDATE pronunciation_training_sessions
           SET active_attempt_id  = p_attempt_id,
               attempt_started_at = NOW(),
               started_at         = NOW(),
               azure_region       = p_azure_region,
               error_code         = NULL,
               error_message      = NULL
         WHERE id = v_id;

        RETURN jsonb_build_object('action', 'reclaimed', 'sessionId', v_id, 'referenceText', v_generated_text, 'dailyCompleted', v_completed);
      END IF;

      -- Still genuinely in flight (e.g. another tab) — unchanged behaviour.
      RETURN jsonb_build_object('error', 'ASSESSMENT_IN_PROGRESS', 'sessionId', v_id);

    ELSE
      RETURN jsonb_build_object('error', 'ASSESSMENT_UNAVAILABLE');
  END CASE;
END;
$function$;

REVOKE ALL ON FUNCTION public.reserve_pronunciation_training_assessment(uuid, date, text, uuid, integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_pronunciation_training_assessment(uuid, date, text, uuid, integer, boolean) TO service_role;
