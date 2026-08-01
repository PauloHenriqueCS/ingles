-- Item 6: remove the technical vendor name from user-facing pronunciation error
-- messages. Only the human-readable `error_message` text changes; the internal
-- `error_code` values (AZURE_NO_MATCH, AZURE_TIMEOUT, ...) are untouched because
-- they are internal identifiers used by logs/telemetry/branching, not shown to
-- the end user. Function body is otherwise identical to the current definition.

CREATE OR REPLACE FUNCTION public.fail_pronunciation_assessment(
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
  v_user_id    UUID;
  v_status     TEXT;
  v_attempt    UUID;
  v_prev_score NUMERIC;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  SELECT status, active_attempt_id, pronunciation_score
  INTO   v_status, v_attempt, v_prev_score
  FROM   pronunciation_assessments
  WHERE  id = p_assessment_id AND user_id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'NOT_FOUND');
  END IF;

  IF v_status = 'completed' OR v_status = 'failed_final' THEN
    RETURN jsonb_build_object('action', 'no_op', 'reason', v_status);
  END IF;

  IF v_status <> 'processing' OR v_attempt IS DISTINCT FROM p_attempt_id THEN
    RETURN jsonb_build_object('action', 'no_op', 'reason', 'not_owner');
  END IF;

  IF v_prev_score IS NOT NULL THEN
    UPDATE pronunciation_assessments
       SET status = 'completed', active_attempt_id = NULL, attempt_started_at = NULL
     WHERE id = p_assessment_id AND user_id = v_user_id;
    RETURN jsonb_build_object('action', 'restored_previous');
  END IF;

  UPDATE pronunciation_assessments
     SET status        = 'failed_retryable',
         error_code    = p_error_code,
         error_message = CASE p_error_code
           WHEN 'AUDIO_DECODE_FAILED' THEN 'Não foi possível preparar o áudio para análise.'
           WHEN 'AUDIO_EMPTY'         THEN 'A gravação está vazia ou corrompida.'
           WHEN 'AZURE_NO_MATCH'      THEN 'Não foi possível reconhecer fala no áudio.'
           WHEN 'AZURE_CANCELED'      THEN 'A análise de pronúncia foi cancelada.'
           WHEN 'AZURE_TIMEOUT'       THEN 'A análise de pronúncia demorou para responder.'
           WHEN 'AZURE_NETWORK_ERROR' THEN 'Erro de rede durante a análise de pronúncia.'
           WHEN 'RESULT_INVALID'      THEN 'O resultado da análise de pronúncia é inválido.'
           WHEN 'CLIENT_INTERRUPTED'  THEN 'A análise foi interrompida antes de ser concluída.'
           ELSE                            'Falha técnica durante a análise de pronúncia.'
         END
   WHERE id = p_assessment_id AND user_id = v_user_id
     AND status = 'processing' AND active_attempt_id = p_attempt_id;

  RETURN jsonb_build_object('action', 'failed_retryable');
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fail_pronunciation_assessment(UUID, UUID, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.fail_pronunciation_assessment(UUID, UUID, TEXT) TO authenticated;
