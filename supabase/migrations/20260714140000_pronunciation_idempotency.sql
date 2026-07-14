-- =============================================================================
-- MIGRATION: 20260714140000_pronunciation_idempotency
-- Projeto: Lemon (english learning app)
--
-- APLICAR UMA ÚNICA VEZ no Supabase SQL Editor:
--   Dashboard → SQL Editor → Nova query → cole este arquivo → Execute
--
-- Esta migration NÃO modifica nem remove dados existentes.
-- Todas as operações são aditivas, exceto a remoção da constraint
-- uq_pronunciation_per_text_version (substituída por uq_pronunciation_idempotency).
-- Idempotente: pode ser executada novamente sem efeito colateral.
--
-- O que esta migration faz:
--   1. Adiciona idempotency_key, reservation_owner e reservation_version à
--      tabela pronunciation_assessments.
--   2. Preenche idempotency_key para linhas existentes (usa id::TEXT como chave).
--   3. Adiciona 'preparing' ao CHECK de status.
--   4. Remove UNIQUE (user_id, text_version_id) que impedia múltiplas análises
--      do mesmo texto por usuário.
--   5. Cria índice único (user_id, idempotency_key) para idempotência por intenção.
--   6. Cria índice composto para consulta da avaliação mais recente por texto.
--   7. Cria reserve_pronunciation_attempt: substitui reserve_pronunciation_assessment
--      usando idempotency_key em vez de active_attempt_id; cria linhas em 'preparing'.
--   8. Cria confirm_pronunciation_preparation: promove 'preparing' → 'processing'
--      após emissão bem-sucedida do token Azure; exige reservation_owner.
--   9. Cria compensate_pronunciation_attempt: promove 'preparing' → 'failed_retryable'
--      quando a emissão do token falha; exige reservation_owner e reservation_version.
--  10. Substitui complete_pronunciation_assessment (remove p_attempt_id).
--  11. Substitui fail_pronunciation_assessment (remove p_attempt_id).
--  12. Revoga e concede permissões nas funções novas/atualizadas.
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 1: Novas colunas
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.pronunciation_assessments
  ADD COLUMN IF NOT EXISTS idempotency_key     TEXT,
  ADD COLUMN IF NOT EXISTS reservation_owner   UUID,
  ADD COLUMN IF NOT EXISTS reservation_version INTEGER NOT NULL DEFAULT 0;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 2: Backfill — linhas existentes recebem id::TEXT como chave
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE public.pronunciation_assessments
   SET idempotency_key = id::TEXT
 WHERE idempotency_key IS NULL;

ALTER TABLE public.pronunciation_assessments
  ALTER COLUMN idempotency_key SET NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 3: Atualizar CHECK de status para incluir 'preparing'
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.pronunciation_assessments
  DROP CONSTRAINT IF EXISTS pronunciation_assessments_status_check;

ALTER TABLE public.pronunciation_assessments
  ADD CONSTRAINT pronunciation_assessments_status_check
    CHECK (status IN ('preparing', 'processing', 'completed', 'failed_retryable', 'failed_final'));

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 4: Remover UNIQUE por texto — permite múltiplas análises do mesmo texto
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.pronunciation_assessments
  DROP CONSTRAINT IF EXISTS uq_pronunciation_per_text_version;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 5: Novo índice único por idempotency_key (proteção definitiva no DB)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS uq_pronunciation_idempotency
  ON public.pronunciation_assessments (user_id, idempotency_key);

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 6: Índice para consulta da avaliação mais recente por texto
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_pronunciation_user_text_latest
  ON public.pronunciation_assessments (user_id, text_version_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 7: reserve_pronunciation_attempt
--
-- Cria uma nova tentativa (linha) para cada intenção do usuário.
-- Cada linha representa UMA tentativa independente; seu id é o assessmentId.
-- A chave idempotente (user_id, idempotency_key) impede duplicidade de
-- intenção: clique duplo ou retry técnico retornam a mesma linha.
-- reservation_owner (gerado pelo servidor) protege a fase de preparação.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.reserve_pronunciation_attempt(
  p_text_version_id UUID,
  p_azure_region    TEXT,
  p_idempotency_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id           UUID;
  v_reference_text    TEXT;
  v_id                UUID;
  v_status            TEXT;
  v_reservation_owner UUID;
  v_reservation_ver   INTEGER;
  v_new_owner         UUID := gen_random_uuid();
  v_rows_inserted     INTEGER;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  -- UUID strings are 36 chars; accept 32–64 to tolerate compact formats
  IF p_idempotency_key IS NULL
     OR length(p_idempotency_key) < 32
     OR length(p_idempotency_key) > 64
  THEN
    RETURN jsonb_build_object('error', 'INVALID_IDEMPOTENCY_KEY');
  END IF;

  -- Validate ownership and copy the text into an immutable snapshot
  SELECT COALESCE(
    NULLIF(trim(er.version_2_text), ''),
    NULLIF(trim(er.corrected_text),  '')
  )
  INTO v_reference_text
  FROM public.english_reviews er
  WHERE er.id      = p_text_version_id
    AND er.user_id = v_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'TEXT_VERSION_NOT_FOUND');
  END IF;

  IF v_reference_text IS NULL THEN
    RETURN jsonb_build_object('error', 'TEXT_VERSION_NOT_ELIGIBLE');
  END IF;

  -- Atomic insertion: the first concurrent call wins; others hit the unique index.
  INSERT INTO public.pronunciation_assessments (
    user_id, text_version_id, status, reference_text,
    language_code, azure_region, started_at,
    idempotency_key, reservation_owner, reservation_version
  )
  VALUES (
    v_user_id, p_text_version_id, 'preparing', v_reference_text,
    'en-US', p_azure_region, NOW(),
    p_idempotency_key, v_new_owner, 1
  )
  ON CONFLICT ON CONSTRAINT uq_pronunciation_idempotency DO NOTHING;

  GET DIAGNOSTICS v_rows_inserted = ROW_COUNT;

  -- Lock the row (new or pre-existing) for the remainder of this transaction
  SELECT pa.id, pa.status, pa.reservation_owner, pa.reservation_version
  INTO   v_id, v_status, v_reservation_owner, v_reservation_ver
  FROM   public.pronunciation_assessments pa
  WHERE  pa.user_id         = v_user_id
    AND  pa.idempotency_key = p_idempotency_key
  FOR UPDATE;

  -- This request created the row and owns the preparation slot
  IF v_rows_inserted = 1 THEN
    RETURN jsonb_build_object(
      'action',             'created',
      'assessmentId',       v_id,
      'referenceText',      v_reference_text,
      'reservationOwner',   v_reservation_owner,
      'reservationVersion', v_reservation_ver
    );
  END IF;

  CASE v_status

    WHEN 'preparing' THEN
      -- Another request with the same key is still preparing
      RETURN jsonb_build_object(
        'action',       'existing_preparing',
        'assessmentId', v_id
      );

    WHEN 'processing' THEN
      -- Token was already issued; this retry can receive a fresh token
      RETURN jsonb_build_object(
        'action',        'existing_processing',
        'assessmentId',  v_id,
        'referenceText', v_reference_text
      );

    WHEN 'completed' THEN
      RETURN jsonb_build_object(
        'error',        'ATTEMPT_ALREADY_COMPLETED',
        'assessmentId', v_id
      );

    WHEN 'failed_retryable', 'failed_final' THEN
      RETURN jsonb_build_object(
        'error',         'ATTEMPT_ALREADY_FAILED',
        'assessmentId',  v_id,
        'currentStatus', v_status
      );

    ELSE
      RETURN jsonb_build_object('error', 'ASSESSMENT_UNAVAILABLE');

  END CASE;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 8: confirm_pronunciation_preparation
--
-- Promove 'preparing' → 'processing' após emissão bem-sucedida do token Azure.
-- Exige reservation_owner e reservation_version para evitar que uma requisição
-- concorrente (com a mesma chave) confirme indevidamente.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.confirm_pronunciation_preparation(
  p_assessment_id       UUID,
  p_reservation_owner   UUID,
  p_reservation_version INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id     UUID;
  v_rows_updated INTEGER;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  UPDATE public.pronunciation_assessments
     SET status              = 'processing',
         reservation_version = reservation_version + 1
   WHERE id                  = p_assessment_id
     AND user_id             = v_user_id
     AND status              = 'preparing'
     AND reservation_owner   = p_reservation_owner
     AND reservation_version = p_reservation_version;

  GET DIAGNOSTICS v_rows_updated = ROW_COUNT;

  IF v_rows_updated = 0 THEN
    RETURN jsonb_build_object('action', 'no_op');
  END IF;

  RETURN jsonb_build_object('action', 'confirmed');
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 9: compensate_pronunciation_attempt
--
-- Marca 'preparing' → 'failed_retryable' quando a emissão do token falha.
-- Exige reservation_owner E reservation_version: somente o criador da reserva
-- pode compensar, e apenas enquanto ninguém mais avançou o estado.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.compensate_pronunciation_attempt(
  p_assessment_id       UUID,
  p_reservation_owner   UUID,
  p_reservation_version INTEGER,
  p_error_code          TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id     UUID;
  v_rows_updated INTEGER;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  UPDATE public.pronunciation_assessments
     SET status              = 'failed_retryable',
         error_code          = p_error_code,
         error_message       = 'Falha ao preparar a análise de pronúncia.',
         reservation_owner   = NULL,
         reservation_version = reservation_version + 1
   WHERE id                  = p_assessment_id
     AND user_id             = v_user_id
     AND status              = 'preparing'
     AND reservation_owner   = p_reservation_owner
     AND reservation_version = p_reservation_version;

  GET DIAGNOSTICS v_rows_updated = ROW_COUNT;

  IF v_rows_updated = 0 THEN
    -- No-op: another request already advanced the state, or wrong owner
    RETURN jsonb_build_object('action', 'no_op');
  END IF;

  RETURN jsonb_build_object('action', 'compensated');
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 10: complete_pronunciation_assessment — sem p_attempt_id
--
-- Cada linha já representa uma tentativa; o assessmentId é suficiente.
-- Idempotente: repetição retorna 'already_completed' sem sobrescrever.
-- ─────────────────────────────────────────────────────────────────────────────

-- Drop the old 11-param version before creating the new 10-param version
DROP FUNCTION IF EXISTS public.complete_pronunciation_assessment(UUID, UUID, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, JSONB, JSONB, NUMERIC);

CREATE OR REPLACE FUNCTION public.complete_pronunciation_assessment(
  p_assessment_id       UUID,
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
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_status  TEXT;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  SELECT pa.status
  INTO   v_status
  FROM   public.pronunciation_assessments pa
  WHERE  pa.id      = p_assessment_id
    AND  pa.user_id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'NOT_FOUND');
  END IF;

  -- Idempotent: same assessment already completed
  IF v_status = 'completed' THEN
    RETURN jsonb_build_object('action', 'already_completed');
  END IF;

  IF v_status <> 'processing' THEN
    RETURN jsonb_build_object('error', 'ASSESSMENT_NOT_PROCESSING', 'currentStatus', v_status);
  END IF;

  UPDATE public.pronunciation_assessments
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
         audio_duration_seconds = p_audio_duration_s,
         reservation_owner      = NULL
   WHERE id      = p_assessment_id
     AND user_id = v_user_id
     AND status  = 'processing';

  RETURN jsonb_build_object('action', 'completed');
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 11: fail_pronunciation_assessment — sem p_attempt_id
--
-- Cada linha é uma tentativa; o assessmentId é suficiente para identificá-la.
-- Idempotente: repetição em estados finais retorna no_op.
-- Não altera linha em 'preparing' (a compensação é feita por /start).
-- ─────────────────────────────────────────────────────────────────────────────

-- Drop the old 3-param version before creating the new 2-param version
DROP FUNCTION IF EXISTS public.fail_pronunciation_assessment(UUID, UUID, TEXT);

CREATE OR REPLACE FUNCTION public.fail_pronunciation_assessment(
  p_assessment_id UUID,
  p_error_code    TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_status  TEXT;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  SELECT pa.status
  INTO   v_status
  FROM   public.pronunciation_assessments pa
  WHERE  pa.id      = p_assessment_id
    AND  pa.user_id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'NOT_FOUND');
  END IF;

  -- Terminal or non-processing states are safe no-ops
  IF v_status IN ('completed', 'failed_final', 'failed_retryable', 'preparing') THEN
    RETURN jsonb_build_object('action', 'no_op', 'reason', v_status);
  END IF;

  -- v_status = 'processing'
  UPDATE public.pronunciation_assessments
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
   WHERE id      = p_assessment_id
     AND user_id = v_user_id
     AND status  = 'processing';

  RETURN jsonb_build_object('action', 'failed_retryable');
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 12: Permissões
-- ─────────────────────────────────────────────────────────────────────────────

REVOKE EXECUTE ON FUNCTION public.reserve_pronunciation_attempt(UUID, TEXT, TEXT)                  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.confirm_pronunciation_preparation(UUID, UUID, INTEGER)            FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.compensate_pronunciation_attempt(UUID, UUID, INTEGER, TEXT)      FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.complete_pronunciation_assessment(UUID, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, JSONB, JSONB, NUMERIC) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fail_pronunciation_assessment(UUID, TEXT)                        FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.reserve_pronunciation_attempt(UUID, TEXT, TEXT)                  TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_pronunciation_preparation(UUID, UUID, INTEGER)            TO authenticated;
GRANT EXECUTE ON FUNCTION public.compensate_pronunciation_attempt(UUID, UUID, INTEGER, TEXT)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_pronunciation_assessment(UUID, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, JSONB, JSONB, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fail_pronunciation_assessment(UUID, TEXT)                        TO authenticated;

COMMIT;
