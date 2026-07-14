-- =============================================================================
-- ROLLBACK: 20260714140000_pronunciation_idempotency
-- Projeto: Lemon (english learning app)
--
-- Aplique SOMENTE se a migration 20260714140000_pronunciation_idempotency.sql
-- foi previamente executada no Supabase. Se a migration NÃO foi aplicada,
-- este script NÃO é necessário — o banco já está no estado correto.
--
-- O que este rollback faz:
--   1. Mantém apenas a linha mais recente por (user_id, text_version_id),
--      descartando linhas duplicadas criadas pelo sistema de idempotência.
--   2. Remove 'preparing' do CHECK de status.
--   3. Remove o índice único uq_pronunciation_idempotency.
--   4. Recria o constraint UNIQUE (user_id, text_version_id).
--   5. Recria complete_pronunciation_assessment com p_attempt_id (11 params).
--   6. Recria fail_pronunciation_assessment com p_attempt_id (3 params).
--   7. Remove as funções do sistema de idempotência.
--   8. Revoga e concede permissões.
--
-- ATENÇÃO: O passo 1 remove linhas duplicadas por texto. Em produção,
-- se o sistema de idempotência criou mais de uma linha por texto por usuário,
-- apenas a mais recente será mantida. Verifique antes com:
--
--   SELECT user_id, text_version_id, COUNT(*) as total
--   FROM pronunciation_assessments
--   GROUP BY user_id, text_version_id
--   HAVING COUNT(*) > 1;
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- PASSO 1: Remover duplicatas, mantendo apenas a linha mais recente por texto
-- ─────────────────────────────────────────────────────────────────────────────

DELETE FROM public.pronunciation_assessments
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY user_id, text_version_id
             ORDER BY created_at DESC
           ) AS rn
    FROM public.pronunciation_assessments
  ) ranked
  WHERE rn > 1
);

-- ─────────────────────────────────────────────────────────────────────────────
-- PASSO 2: Restaurar CHECK de status (sem 'preparing')
-- ─────────────────────────────────────────────────────────────────────────────

-- Primeiro converte qualquer linha 'preparing' sobrevivente em 'failed_retryable'
UPDATE public.pronunciation_assessments
   SET status = 'failed_retryable'
 WHERE status = 'preparing';

ALTER TABLE public.pronunciation_assessments
  DROP CONSTRAINT IF EXISTS pronunciation_assessments_status_check;

ALTER TABLE public.pronunciation_assessments
  ADD CONSTRAINT pronunciation_assessments_status_check
    CHECK (status IN ('processing', 'completed', 'failed_retryable', 'failed_final'));

-- ─────────────────────────────────────────────────────────────────────────────
-- PASSO 3: Remover índice de idempotência
-- ─────────────────────────────────────────────────────────────────────────────

DROP INDEX IF EXISTS public.uq_pronunciation_idempotency;

-- ─────────────────────────────────────────────────────────────────────────────
-- PASSO 4: Recriar constraint UNIQUE (user_id, text_version_id)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.pronunciation_assessments
  DROP CONSTRAINT IF EXISTS uq_pronunciation_per_text_version;

ALTER TABLE public.pronunciation_assessments
  ADD CONSTRAINT uq_pronunciation_per_text_version
    UNIQUE (user_id, text_version_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- PASSO 5: Recriar complete_pronunciation_assessment (com p_attempt_id)
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.complete_pronunciation_assessment(UUID, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, JSONB, JSONB, NUMERIC);

CREATE OR REPLACE FUNCTION public.complete_pronunciation_assessment(
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

  IF v_status = 'completed' AND v_attempt = p_attempt_id THEN
    RETURN jsonb_build_object('action', 'already_completed');
  END IF;

  IF v_status = 'completed' THEN
    RETURN jsonb_build_object('error', 'ASSESSMENT_ALREADY_COMPLETED');
  END IF;

  IF v_status <> 'processing' THEN
    RETURN jsonb_build_object('error', 'ASSESSMENT_NOT_PROCESSING', 'currentStatus', v_status);
  END IF;

  IF v_attempt IS DISTINCT FROM p_attempt_id THEN
    RETURN jsonb_build_object('error', 'ATTEMPT_MISMATCH');
  END IF;

  UPDATE pronunciation_assessments
     SET status                 = 'completed',
         completed_at           = NOW(),
         pronunciation_score    = p_pronunciation_score,
         accuracy_score         = p_accuracy_score,
         fluency_score          = p_fluency_score,
         completeness_score     = p_completeness_score,
         prosody_score          = p_prosody_score,
         recognized_text        = p_recognized_text,
         words_json             = p_words_json,
         raw_result_json        = p_raw_result_json,
         audio_duration_seconds = p_audio_duration_s
   WHERE id                = p_assessment_id
     AND user_id           = v_user_id
     AND status            = 'processing'
     AND active_attempt_id = p_attempt_id;

  RETURN jsonb_build_object('action', 'completed');
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- PASSO 6: Recriar fail_pronunciation_assessment (com p_attempt_id)
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.fail_pronunciation_assessment(UUID, TEXT);

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
  WHERE  id      = p_assessment_id
    AND  user_id = v_user_id
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
       SET status             = 'completed',
           active_attempt_id  = NULL,
           attempt_started_at = NULL
     WHERE id      = p_assessment_id
       AND user_id = v_user_id;
    RETURN jsonb_build_object('action', 'restored_previous');
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

-- ─────────────────────────────────────────────────────────────────────────────
-- PASSO 7: Remover funções do sistema de idempotência
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.reserve_pronunciation_attempt(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.confirm_pronunciation_preparation(UUID, UUID, INTEGER);
DROP FUNCTION IF EXISTS public.compensate_pronunciation_attempt(UUID, UUID, INTEGER, TEXT);

-- ─────────────────────────────────────────────────────────────────────────────
-- PASSO 8: Permissões
-- ─────────────────────────────────────────────────────────────────────────────

REVOKE EXECUTE ON FUNCTION public.complete_pronunciation_assessment(UUID, UUID, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, JSONB, JSONB, NUMERIC) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fail_pronunciation_assessment(UUID, UUID, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.complete_pronunciation_assessment(UUID, UUID, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, JSONB, JSONB, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fail_pronunciation_assessment(UUID, UUID, TEXT) TO authenticated;

COMMIT;
