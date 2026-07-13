-- Atomic pronunciation assessment reservation functions
-- Called exclusively from api/pronunciation/start — never by client-side code.
--
-- reserve_pronunciation_assessment:
--   Inserts a new 'processing' row, or branches on the existing row's status.
--   SECURITY DEFINER bypasses RLS for INSERT/UPDATE; ownership is verified by
--   checking auth.uid() against english_reviews.user_id.
--
-- compensate_pronunciation_assessment:
--   Rolls back to 'failed_retryable' after an Azure token issuance failure.
--   Only updates the row if it is still 'processing' and belongs to the caller.
--   Safe to call from concurrent requests — the WHERE clause prevents double-compensation.

-- ── Reserve function ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION reserve_pronunciation_assessment(
  p_text_version_id UUID,
  p_azure_region    TEXT
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
  v_rows_inserted  INTEGER;
BEGIN
  -- Caller identity comes from the JWT; requireAuth guarantees non-null
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  -- Validate ownership and resolve the reference text.
  -- version_2_text (user's rewrite) takes priority over corrected_text (AI correction),
  -- matching the reference text shown in PronunciationRecorder on the frontend.
  SELECT COALESCE(
    NULLIF(trim(version_2_text),  ''),
    NULLIF(trim(corrected_text),  '')
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
    language_code, azure_region, started_at
  )
  VALUES (
    v_user_id, p_text_version_id, 'processing', v_reference_text,
    'en-US', p_azure_region, NOW()
  )
  ON CONFLICT ON CONSTRAINT uq_pronunciation_per_text_version DO NOTHING;

  GET DIAGNOSTICS v_rows_inserted = ROW_COUNT;

  -- Lock the row for the rest of this transaction.
  -- Concurrent reactivations (failed_retryable → processing) block here and then
  -- re-read the already-updated 'processing' state, returning 'existing_processing'.
  SELECT id, status
  INTO   v_id, v_status
  FROM   pronunciation_assessments
  WHERE  user_id         = v_user_id
    AND  text_version_id = p_text_version_id
  FOR UPDATE;

  -- We just created this reservation
  IF v_rows_inserted = 1 THEN
    RETURN jsonb_build_object(
      'action',        'created',
      'assessmentId',  v_id,
      'referenceText', v_reference_text
    );
  END IF;

  -- Row pre-existed — branch by its current status
  CASE v_status

    WHEN 'processing' THEN
      -- Idempotent: do not change started_at (it belongs to the earlier request)
      RETURN jsonb_build_object(
        'action',        'existing_processing',
        'assessmentId',  v_id,
        'referenceText', v_reference_text
      );

    WHEN 'failed_retryable' THEN
      -- Reactivate for a new attempt; re-confirm status under the FOR UPDATE lock
      UPDATE pronunciation_assessments
         SET status        = 'processing',
             started_at    = NOW(),
             error_code    = NULL,
             error_message = NULL
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

-- ── Compensation function ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION compensate_pronunciation_assessment(
  p_assessment_id UUID,
  p_error_code    TEXT,
  p_error_message TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  -- Only update if the row is still 'processing' and belongs to this user.
  -- If the row has advanced (completed / failed by another path) this is a no-op.
  -- Safe for concurrent calls: both would produce the same failed_retryable result.
  UPDATE pronunciation_assessments
     SET status        = 'failed_retryable',
         error_code    = p_error_code,
         error_message = p_error_message
   WHERE id      = p_assessment_id
     AND user_id = v_user_id
     AND status  = 'processing';
END;
$$;

-- ── Permissions ───────────────────────────────────────────────────────────────

REVOKE EXECUTE ON FUNCTION reserve_pronunciation_assessment(UUID, TEXT)       FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION compensate_pronunciation_assessment(UUID, TEXT, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION reserve_pronunciation_assessment(UUID, TEXT)       TO authenticated;
GRANT EXECUTE ON FUNCTION compensate_pronunciation_assessment(UUID, TEXT, TEXT) TO authenticated;
