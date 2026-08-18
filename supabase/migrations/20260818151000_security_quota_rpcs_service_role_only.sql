-- ============================================================================
-- Security hardening — quota/reservation RPCs must not trust client-supplied
-- entitlement limits.
--
-- Root cause: consume_listening_pending_story / create_pronunciation_training_
-- text / reserve_pronunciation_training_assessment / reserve_writing_review were
-- SECURITY DEFINER and EXECUTE-granted to `authenticated`, while taking the
-- daily limit (p_effective_limit / p_unlimited / p_limit) as CLIENT arguments.
-- A user could call them directly with p_unlimited => true and bypass the paid
-- per-plan quota (e.g. reserve unlimited pronunciation assessments → unbounded
-- Azure spend).
--
-- Fix (chosen for being the hardest to misuse): each function is now
-- SERVICE-ROLE-ONLY and derives the user from an explicit `p_user_id` supplied
-- exclusively by trusted server code. The limit arguments are therefore only
-- ever set by the API route, which resolves them from
-- getCurrentUserPlanEntitlements — the single server-side source of truth. The
-- routes are updated in the same change to call these via the service-role
-- client. auth.uid() is no longer used (it would be NULL under service_role).
--
-- Behaviour is otherwise byte-for-byte preserved from the previous bodies.
-- Idempotent: DROP ... IF EXISTS the old signatures, then (re)create + re-lock.
-- ============================================================================

-- Drop the old client-callable signatures (no DB object depends on them; every
-- caller is application code updated in this same deploy).
DROP FUNCTION IF EXISTS public.consume_listening_pending_story(uuid, date, integer, boolean);
DROP FUNCTION IF EXISTS public.create_pronunciation_training_text(date, text, text, boolean, integer, boolean, uuid, text);
DROP FUNCTION IF EXISTS public.reserve_pronunciation_training_assessment(date, text, uuid, integer, boolean);
DROP FUNCTION IF EXISTS public.reserve_writing_review(uuid, boolean, integer);

-- ── consume_listening_pending_story ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.consume_listening_pending_story(
  p_user_id uuid, p_shared_story_id uuid, p_practice_date date, p_effective_limit integer, p_unlimited boolean
) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id   UUID;
  v_completed BOOLEAN;
  v_consumed  INTEGER;
BEGIN
  v_user_id := p_user_id;
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  SELECT completed INTO v_completed
  FROM   user_listening_shared_progress
  WHERE  user_id = v_user_id AND shared_story_id = p_shared_story_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'NOT_PREPARED');
  END IF;

  SELECT count(*) INTO v_consumed
  FROM   user_listening_shared_progress
  WHERE  user_id = v_user_id AND activity_date = p_practice_date AND completed = true;

  IF v_completed THEN
    RETURN jsonb_build_object('action', 'already_consumed', 'consumed', v_consumed);
  END IF;

  IF NOT COALESCE(p_unlimited, false) AND v_consumed >= COALESCE(p_effective_limit, 0) THEN
    RETURN jsonb_build_object('error', 'DAILY_LIMIT_REACHED', 'consumed', v_consumed);
  END IF;

  UPDATE user_listening_shared_progress
     SET completed = true, completed_at = now(), updated_at = now()
   WHERE user_id = v_user_id AND shared_story_id = p_shared_story_id AND completed = false;

  RETURN jsonb_build_object('action', 'consumed', 'consumed', v_consumed + 1);
END;
$function$;

REVOKE ALL ON FUNCTION public.consume_listening_pending_story(uuid, uuid, date, integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_listening_pending_story(uuid, uuid, date, integer, boolean) TO service_role;

-- ── create_pronunciation_training_text ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_pronunciation_training_text(
  p_user_id uuid, p_practice_date date, p_level text, p_generated_text text, p_start_new_round boolean,
  p_effective_limit integer, p_unlimited boolean, p_curriculum_version_id uuid, p_curriculum_subtopic_key text
) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id   UUID;
  v_row       RECORD;
  v_completed INTEGER;
BEGIN
  v_user_id := p_user_id;
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  IF p_generated_text IS NULL OR length(trim(p_generated_text)) = 0 THEN
    RETURN jsonb_build_object('error', 'INVALID_TEXT');
  END IF;

  SELECT count(*) INTO v_completed
  FROM   pronunciation_training_sessions
  WHERE  user_id = v_user_id AND practice_date = p_practice_date AND status = 'completed';

  SELECT id, level, generated_text, status,
         pronunciation_score, accuracy_score, fluency_score, completeness_score, prosody_score,
         recognized_text, words_json, raw_result_json, audio_duration_seconds,
         curriculum_version_id, curriculum_subtopic_key
  INTO   v_row
  FROM   pronunciation_training_sessions
  WHERE  user_id = v_user_id AND practice_date = p_practice_date AND status <> 'completed'
  LIMIT  1;

  IF NOT FOUND THEN
    IF v_completed > 0 AND NOT COALESCE(p_start_new_round, false) THEN
      SELECT id, level, generated_text, status,
             pronunciation_score, accuracy_score, fluency_score, completeness_score, prosody_score,
             recognized_text, words_json, raw_result_json, audio_duration_seconds,
             curriculum_version_id, curriculum_subtopic_key
      INTO   v_row
      FROM   pronunciation_training_sessions
      WHERE  user_id = v_user_id AND practice_date = p_practice_date AND status = 'completed'
      ORDER BY completed_at DESC NULLS LAST
      LIMIT  1;
    ELSE
      IF NOT COALESCE(p_unlimited, false) AND v_completed >= COALESCE(p_effective_limit, 0) THEN
        RETURN jsonb_build_object('error', 'DAILY_LIMIT_REACHED', 'dailyCompleted', v_completed);
      END IF;

      INSERT INTO pronunciation_training_sessions
        (user_id, practice_date, level, generated_text, status, curriculum_version_id, curriculum_subtopic_key)
      VALUES
        (v_user_id, p_practice_date, p_level, p_generated_text, 'text_generated', p_curriculum_version_id, p_curriculum_subtopic_key)
      ON CONFLICT (user_id, practice_date) WHERE status <> 'completed' DO NOTHING;

      SELECT id, level, generated_text, status,
             pronunciation_score, accuracy_score, fluency_score, completeness_score, prosody_score,
             recognized_text, words_json, raw_result_json, audio_duration_seconds,
             curriculum_version_id, curriculum_subtopic_key
      INTO   v_row
      FROM   pronunciation_training_sessions
      WHERE  user_id = v_user_id AND practice_date = p_practice_date AND status <> 'completed'
      LIMIT  1;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'sessionId',      v_row.id,
    'level',          v_row.level,
    'text',           v_row.generated_text,
    'status',         v_row.status,
    'dailyCompleted', v_completed,
    'curriculumVersionId',  v_row.curriculum_version_id,
    'curriculumSubtopicKey', v_row.curriculum_subtopic_key,
    'result', CASE WHEN v_row.status = 'completed' THEN jsonb_build_object(
      'pronunciationScore',   v_row.pronunciation_score,
      'accuracyScore',        v_row.accuracy_score,
      'fluencyScore',         v_row.fluency_score,
      'completenessScore',    v_row.completeness_score,
      'prosodyScore',         v_row.prosody_score,
      'recognizedText',       v_row.recognized_text,
      'wordsJson',            v_row.words_json,
      'rawSegments',          v_row.raw_result_json,
      'audioDurationSeconds', v_row.audio_duration_seconds
    ) ELSE NULL END
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.create_pronunciation_training_text(uuid, date, text, text, boolean, integer, boolean, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_pronunciation_training_text(uuid, date, text, text, boolean, integer, boolean, uuid, text) TO service_role;

-- ── reserve_pronunciation_training_assessment ───────────────────────────────
CREATE OR REPLACE FUNCTION public.reserve_pronunciation_training_assessment(
  p_user_id uuid, p_practice_date date, p_azure_region text, p_attempt_id uuid, p_effective_limit integer, p_unlimited boolean
) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id        UUID;
  v_id             UUID;
  v_status         TEXT;
  v_active_attempt UUID;
  v_generated_text TEXT;
  v_consumed       INTEGER;
  v_completed      INTEGER;
BEGIN
  v_user_id := p_user_id;
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  IF p_attempt_id IS NULL THEN
    RETURN jsonb_build_object('error', 'INVALID_ATTEMPT_ID');
  END IF;

  SELECT id, status, active_attempt_id, generated_text
  INTO   v_id, v_status, v_active_attempt, v_generated_text
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
      IF v_active_attempt = p_attempt_id THEN
        RETURN jsonb_build_object('action', 'existing_processing', 'sessionId', v_id, 'referenceText', v_generated_text, 'dailyCompleted', v_completed);
      ELSE
        RETURN jsonb_build_object('error', 'ASSESSMENT_IN_PROGRESS', 'sessionId', v_id);
      END IF;

    ELSE
      RETURN jsonb_build_object('error', 'ASSESSMENT_UNAVAILABLE');
  END CASE;
END;
$function$;

REVOKE ALL ON FUNCTION public.reserve_pronunciation_training_assessment(uuid, date, text, uuid, integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_pronunciation_training_assessment(uuid, date, text, uuid, integer, boolean) TO service_role;

-- ── reserve_writing_review ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reserve_writing_review(
  p_user_id uuid, p_attempt_id uuid, p_unlimited boolean, p_limit integer
) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id      UUID;
  v_id           UUID;
  v_status       TEXT;
  v_review_id    UUID;
  v_found        BOOLEAN;
  v_today_start  TIMESTAMPTZ;
  v_today_end    TIMESTAMPTZ;
  v_consumed     INTEGER;
BEGIN
  v_user_id := p_user_id;
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  IF p_attempt_id IS NULL THEN
    RETURN jsonb_build_object('error', 'INVALID_ATTEMPT_ID');
  END IF;

  p_unlimited := coalesce(p_unlimited, false);
  p_limit := coalesce(p_limit, 0);

  PERFORM pg_advisory_xact_lock(hashtext('writing_review'), hashtext(v_user_id::text));

  SELECT id, status, review_id
  INTO   v_id, v_status, v_review_id
  FROM   writing_review_reservations
  WHERE  user_id = v_user_id AND attempt_id = p_attempt_id
  FOR UPDATE;
  v_found := FOUND;

  IF v_found AND v_status = 'completed' THEN
    RETURN jsonb_build_object('status', 'completed', 'reservationId', v_id, 'reviewId', v_review_id, 'fresh', false);
  END IF;
  IF v_found AND v_status = 'reserved' THEN
    RETURN jsonb_build_object('status', 'in_progress', 'reservationId', v_id, 'fresh', false);
  END IF;

  IF NOT p_unlimited THEN
    v_today_start := date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
    v_today_end   := v_today_start + interval '1 day';

    SELECT count(*) INTO v_consumed
    FROM   writing_review_reservations
    WHERE  user_id = v_user_id
      AND  status IN ('reserved', 'completed')
      AND  created_at >= v_today_start
      AND  created_at < v_today_end;

    IF v_consumed >= p_limit THEN
      RETURN jsonb_build_object('error', 'DAILY_LIMIT_REACHED');
    END IF;
  END IF;

  IF v_found THEN
    UPDATE writing_review_reservations
       SET status = 'reserved', review_id = NULL, updated_at = now()
     WHERE id = v_id;
  ELSE
    INSERT INTO writing_review_reservations (user_id, attempt_id, status)
    VALUES (v_user_id, p_attempt_id, 'reserved')
    RETURNING id INTO v_id;
  END IF;

  RETURN jsonb_build_object('status', 'reserved', 'reservationId', v_id, 'fresh', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.reserve_writing_review(uuid, uuid, boolean, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_writing_review(uuid, uuid, boolean, integer) TO service_role;
