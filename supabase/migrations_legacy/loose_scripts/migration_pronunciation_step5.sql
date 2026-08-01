-- Step 5: attempt identity, complete and fail functions
--
-- Adds active_attempt_id + attempt_started_at so each active attempt owns a slot.
-- Replaces reserve_pronunciation_assessment with a 3-parameter version that:
--   • enforces one active attempt at a time (ASSESSMENT_IN_PROGRESS for different attemptId)
--   • is idempotent for the same attemptId re-requesting a token
-- Adds complete_pronunciation_assessment and fail_pronunciation_assessment.
--
-- LIMITATION: The token delivered to the browser is not a single-use credential.
-- Two browser instances holding the same token can both call Azure before /complete fires.
-- This function prevents two REQUESTS from each getting their own token; it cannot prevent
-- a token already issued from being replayed. That is an Azure-platform constraint.

-- ── 1. New columns ────────────────────────────────────────────────────────────

ALTER TABLE pronunciation_assessments
  ADD COLUMN IF NOT EXISTS active_attempt_id  UUID,
  ADD COLUMN IF NOT EXISTS attempt_started_at TIMESTAMPTZ;

-- ── 2. Drop old 2-param reserve (replaced below with 3-param version) ─────────

DROP FUNCTION IF EXISTS reserve_pronunciation_assessment(UUID, TEXT);

-- ── 3. reserve_pronunciation_assessment (3-param, replaces Etapa 4) ───────────

CREATE OR REPLACE FUNCTION reserve_pronunciation_assessment(
  p_text_version_id UUID,
  p_azure_region    TEXT,
  p_attempt_id      UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id        UUID;
  v_reference_text TEXT;
  v_id             UUID;
  v_status         TEXT;
  v_active_attempt UUID;
  v_rows_inserted  INTEGER;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  IF p_attempt_id IS NULL THEN
    RETURN jsonb_build_object('error', 'INVALID_ATTEMPT_ID');
  END IF;

  -- Validate ownership and resolve the reference text.
  SELECT COALESCE(
    NULLIF(trim(version_2_text), ''),
    NULLIF(trim(corrected_text), '')
  )
  INTO v_reference_text
  FROM english_reviews
  WHERE id      = p_text_version_id
    AND user_id = v_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'TEXT_VERSION_NOT_FOUND');
  END IF;

  IF v_reference_text IS NULL THEN
    RETURN jsonb_build_object('error', 'TEXT_VERSION_NOT_ELIGIBLE');
  END IF;

  -- Atomic reservation: one INSERT wins; concurrent inserts hit the unique constraint.
  INSERT INTO pronunciation_assessments (
    user_id, text_version_id, status, reference_text,
    language_code, azure_region, started_at,
    active_attempt_id, attempt_started_at
  )
  VALUES (
    v_user_id, p_text_version_id, 'processing', v_reference_text,
    'en-US', p_azure_region, NOW(),
    p_attempt_id, NOW()
  )
  ON CONFLICT ON CONSTRAINT uq_pronunciation_per_text_version DO NOTHING;

  GET DIAGNOSTICS v_rows_inserted = ROW_COUNT;

  -- Lock the row for the rest of this transaction.
  SELECT id, status, active_attempt_id
  INTO   v_id, v_status, v_active_attempt
  FROM   pronunciation_assessments
  WHERE  user_id         = v_user_id
    AND  text_version_id = p_text_version_id
  FOR UPDATE;

  IF v_rows_inserted = 1 THEN
    RETURN jsonb_build_object(
      'action',        'created',
      'assessmentId',  v_id,
      'referenceText', v_reference_text
    );
  END IF;

  CASE v_status

    WHEN 'processing' THEN
      IF v_active_attempt = p_attempt_id THEN
        -- Same attempt re-requesting (e.g. token expired): idempotent
        RETURN jsonb_build_object(
          'action',        'existing_processing',
          'assessmentId',  v_id,
          'referenceText', v_reference_text
        );
      ELSE
        -- Different attempt: another tab/request holds the active slot
        RETURN jsonb_build_object(
          'error',        'ASSESSMENT_IN_PROGRESS',
          'assessmentId', v_id
        );
      END IF;

    WHEN 'failed_retryable' THEN
      UPDATE pronunciation_assessments
         SET status             = 'processing',
             started_at         = NOW(),
             active_attempt_id  = p_attempt_id,
             attempt_started_at = NOW(),
             error_code         = NULL,
             error_message      = NULL
       WHERE id      = v_id
         AND user_id = v_user_id
         AND status  = 'failed_retryable';

      RETURN jsonb_build_object(
        'action',        'reactivated',
        'assessmentId',  v_id,
        'referenceText', v_reference_text
      );

    WHEN 'completed' THEN
      RETURN jsonb_build_object(
        'error',        'ASSESSMENT_ALREADY_COMPLETED',
        'assessmentId', v_id
      );

    WHEN 'failed_final' THEN
      RETURN jsonb_build_object(
        'error',        'ASSESSMENT_NOT_RETRYABLE',
        'assessmentId', v_id
      );

    ELSE
      RETURN jsonb_build_object('error', 'ASSESSMENT_UNAVAILABLE');

  END CASE;
END;
$$;

-- ── 4. complete_pronunciation_assessment ──────────────────────────────────────

CREATE OR REPLACE FUNCTION complete_pronunciation_assessment(
  p_assessment_id       UUID,
  p_attempt_id          UUID,
  p_pronunciation_score NUMERIC,
  p_accuracy_score      NUMERIC,
  p_fluency_score       NUMERIC,
  p_completeness_score  NUMERIC,
  p_prosody_score       NUMERIC,
  p_recognized_text     TEXT,
  p_words_json          JSONB,
  p_raw_result_json     JSONB,
  p_audio_duration_s    NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_status  TEXT;
  v_attempt UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  SELECT status, active_attempt_id
  INTO   v_status, v_attempt
  FROM   pronunciation_assessments
  WHERE  id      = p_assessment_id
    AND  user_id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'NOT_FOUND');
  END IF;

  -- Idempotent: same attempt already completed this slot
  IF v_status = 'completed' AND v_attempt = p_attempt_id THEN
    RETURN jsonb_build_object('action', 'already_completed');
  END IF;

  IF v_status = 'completed' THEN
    RETURN jsonb_build_object('error', 'ASSESSMENT_ALREADY_COMPLETED');
  END IF;

  IF v_status <> 'processing' THEN
    RETURN jsonb_build_object('error', 'ASSESSMENT_NOT_PROCESSING', 'currentStatus', v_status);
  END IF;

  -- A stale attempt cannot complete a newer one
  IF v_attempt IS DISTINCT FROM p_attempt_id THEN
    RETURN jsonb_build_object('error', 'ATTEMPT_MISMATCH');
  END IF;

  UPDATE pronunciation_assessments
     SET status              = 'completed',
         completed_at        = NOW(),
         pronunciation_score = p_pronunciation_score,
         accuracy_score      = p_accuracy_score,
         fluency_score       = p_fluency_score,
         completeness_score  = p_completeness_score,
         prosody_score       = p_prosody_score,
         recognized_text     = p_recognized_text,
         words_json          = p_words_json,
         raw_result_json     = p_raw_result_json,
         audio_duration_seconds = p_audio_duration_s
   WHERE id                = p_assessment_id
     AND user_id           = v_user_id
     AND status            = 'processing'
     AND active_attempt_id = p_attempt_id;

  RETURN jsonb_build_object('action', 'completed');
END;
$$;

-- ── 5. fail_pronunciation_assessment ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION fail_pronunciation_assessment(
  p_assessment_id UUID,
  p_attempt_id    UUID,
  p_error_code    TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_status  TEXT;
  v_attempt UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  SELECT status, active_attempt_id
  INTO   v_status, v_attempt
  FROM   pronunciation_assessments
  WHERE  id      = p_assessment_id
    AND  user_id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'NOT_FOUND');
  END IF;

  -- Never alter a completed or permanently failed row
  IF v_status = 'completed' OR v_status = 'failed_final' THEN
    RETURN jsonb_build_object('action', 'no_op', 'reason', v_status);
  END IF;

  -- A stale attempt cannot affect a newer active attempt
  IF v_status <> 'processing' OR v_attempt IS DISTINCT FROM p_attempt_id THEN
    RETURN jsonb_build_object('action', 'no_op', 'reason', 'not_owner');
  END IF;

  UPDATE pronunciation_assessments
     SET status        = 'failed_retryable',
         error_code    = p_error_code,
         error_message = CASE p_error_code
           WHEN 'AUDIO_DECODE_FAILED'  THEN 'Não foi possível preparar o áudio para análise.'
           WHEN 'AUDIO_EMPTY'          THEN 'A gravação está vazia ou corrompida.'
           WHEN 'AZURE_NO_MATCH'       THEN 'O Azure não reconheceu fala no áudio.'
           WHEN 'AZURE_CANCELED'       THEN 'A análise foi cancelada pelo serviço.'
           WHEN 'AZURE_TIMEOUT'        THEN 'O serviço de pronúncia demorou para responder.'
           WHEN 'AZURE_NETWORK_ERROR'  THEN 'Erro de rede durante a análise de pronúncia.'
           WHEN 'RESULT_INVALID'       THEN 'O resultado retornado pelo serviço é inválido.'
           WHEN 'CLIENT_INTERRUPTED'   THEN 'A análise foi interrompida antes de ser concluída.'
           ELSE                             'Falha técnica durante a análise de pronúncia.'
         END
   WHERE id                = p_assessment_id
     AND user_id           = v_user_id
     AND status            = 'processing'
     AND active_attempt_id = p_attempt_id;

  RETURN jsonb_build_object('action', 'failed_retryable');
END;
$$;

-- ── 6. Permissions ────────────────────────────────────────────────────────────

REVOKE EXECUTE ON FUNCTION reserve_pronunciation_assessment(UUID, TEXT, UUID)    FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION complete_pronunciation_assessment(UUID, UUID, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, JSONB, JSONB, NUMERIC) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION fail_pronunciation_assessment(UUID, UUID, TEXT)        FROM PUBLIC;

GRANT EXECUTE ON FUNCTION reserve_pronunciation_assessment(UUID, TEXT, UUID)    TO authenticated;
GRANT EXECUTE ON FUNCTION complete_pronunciation_assessment(UUID, UUID, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, JSONB, JSONB, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION fail_pronunciation_assessment(UUID, UUID, TEXT)        TO authenticated;
