-- =============================================================================
-- MIGRATION: 20260812170000_pronunciation_training_dynamic_daily_limit
-- Projeto: Orodim
--
-- Aplicada automaticamente por .github/workflows/deploy-production.yml
-- (supabase db push) após o merge na main, e por homologation.yml em develop.
-- Não aplicar manualmente no SQL Editor.
--
-- OBJETIVO: remover o teto arquitetural de 1 análise/dia do "Treinar Pronúncia"
-- e passar a respeitar o LIMITE EFETIVO configurado no plano/capability
-- (pronunciation.evaluations_per_day / .unlimited), resolvido server-side pelo
-- entitlements service e passado às RPCs — SEM número comercial embutido em SQL.
--
-- MODELO: antes havia UMA linha por (user, practice_date) (uq_pts_user_date),
-- e o reserve bloqueava assim que essa linha ficava 'completed'. Agora podem
-- existir VÁRIAS linhas 'completed' por dia (uma por rodada de análise), mas no
-- máximo UMA linha "ativa" (status <> 'completed') por vez — garantido por um
-- índice único PARCIAL. Esse invariante de linha-ativa-única serializa reservas
-- concorrentes (FOR UPDATE nessa linha) e torna a checagem de cota atômica sem
-- advisory lock nem contador materializado. O limite é comparado contra a
-- contagem real de linhas 'processing'/'completed' do dia (SP).
--
-- COMPATIBILIDADE: aditivo/estrutural. Não apaga dados. Linhas existentes
-- (uma por user/dia) continuam válidas — 'completed' vira apenas "rodada 1
-- concluída"; qualquer linha ativa remanescente continua sendo a linha ativa.
-- Preserva SECURITY DEFINER, search_path, RLS e os grants existentes.
-- =============================================================================

-- 1. Índice único PARCIAL: no máximo uma linha não-concluída por (user, dia).
--    Criado ANTES de remover a constraint antiga para nunca deixar uma janela
--    sem proteção contra duas linhas ativas simultâneas.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pts_active_per_day
  ON public.pronunciation_training_sessions (user_id, practice_date)
  WHERE status <> 'completed';

-- 2. Remove a unicidade "uma linha por dia" (permite várias 'completed'/dia).
--    O índice não-único idx_pts_user_date (lookups) é preservado.
ALTER TABLE public.pronunciation_training_sessions
  DROP CONSTRAINT IF EXISTS uq_pts_user_date;

-- =============================================================================
-- create_pronunciation_training_text — nova assinatura
--   (p_practice_date, p_level, p_generated_text, p_start_new_round,
--    p_effective_limit, p_unlimited)
-- Substitui a antiga (…, p_force_new). Drop explícito da antiga + create da nova
-- + re-grant idêntico (nunca amplia permissões).
-- =============================================================================
DROP FUNCTION IF EXISTS public.create_pronunciation_training_text(date, text, text, boolean);

CREATE OR REPLACE FUNCTION public.create_pronunciation_training_text(
  p_practice_date    date,
  p_level            text,
  p_generated_text   text,
  p_start_new_round  boolean,
  p_effective_limit  integer,
  p_unlimited        boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id   UUID;
  v_row       RECORD;
  v_completed INTEGER;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  IF p_generated_text IS NULL OR length(trim(p_generated_text)) = 0 THEN
    RETURN jsonb_build_object('error', 'INVALID_TEXT');
  END IF;

  -- Quantas rodadas já foram concluídas hoje (contador real do dia).
  SELECT count(*) INTO v_completed
  FROM   pronunciation_training_sessions
  WHERE  user_id = v_user_id AND practice_date = p_practice_date AND status = 'completed';

  -- (1) Linha ATIVA existente (texto ainda não avaliado, em processamento, ou
  -- falha retryable): recarregar sempre devolve ela — nunca gera um novo texto
  -- enquanto há uma rodada pendente. O índice parcial garante no máximo uma.
  SELECT id, level, generated_text, status,
         pronunciation_score, accuracy_score, fluency_score, completeness_score, prosody_score,
         recognized_text, words_json, raw_result_json, audio_duration_seconds
  INTO   v_row
  FROM   pronunciation_training_sessions
  WHERE  user_id = v_user_id AND practice_date = p_practice_date AND status <> 'completed'
  LIMIT  1;

  IF NOT FOUND THEN
    IF v_completed > 0 AND NOT COALESCE(p_start_new_round, false) THEN
      -- (2) Sem linha ativa, já há rodadas concluídas e o usuário NÃO pediu uma
      -- nova rodada: devolve a última concluída (estado "concluído") sem gerar
      -- nada — preserva o "recarregar após terminar mostra o resultado".
      SELECT id, level, generated_text, status,
             pronunciation_score, accuracy_score, fluency_score, completeness_score, prosody_score,
             recognized_text, words_json, raw_result_json, audio_duration_seconds
      INTO   v_row
      FROM   pronunciation_training_sessions
      WHERE  user_id = v_user_id AND practice_date = p_practice_date AND status = 'completed'
      ORDER BY completed_at DESC NULLS LAST
      LIMIT  1;
    ELSE
      -- (3) Criar nova rodada (primeiro texto do dia, ou nova rodada explícita).
      -- Gate de cota dinâmico: bloqueia se já atingiu o limite configurado.
      IF NOT COALESCE(p_unlimited, false) AND v_completed >= COALESCE(p_effective_limit, 0) THEN
        RETURN jsonb_build_object('error', 'DAILY_LIMIT_REACHED', 'dailyCompleted', v_completed);
      END IF;

      -- Insert atômico: ON CONFLICT no índice parcial resolve a corrida entre
      -- dois generate simultâneos — só uma linha ativa sobrevive.
      INSERT INTO pronunciation_training_sessions (user_id, practice_date, level, generated_text, status)
      VALUES (v_user_id, p_practice_date, p_level, p_generated_text, 'text_generated')
      ON CONFLICT (user_id, practice_date) WHERE status <> 'completed' DO NOTHING;

      SELECT id, level, generated_text, status,
             pronunciation_score, accuracy_score, fluency_score, completeness_score, prosody_score,
             recognized_text, words_json, raw_result_json, audio_duration_seconds
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
$$;

REVOKE ALL ON FUNCTION public.create_pronunciation_training_text(date, text, text, boolean, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_pronunciation_training_text(date, text, text, boolean, integer, boolean) TO anon;
GRANT EXECUTE ON FUNCTION public.create_pronunciation_training_text(date, text, text, boolean, integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_pronunciation_training_text(date, text, text, boolean, integer, boolean) TO service_role;

-- =============================================================================
-- reserve_pronunciation_training_assessment — nova assinatura
--   (p_practice_date, p_azure_region, p_attempt_id, p_effective_limit, p_unlimited)
-- O contrato do cliente/handler é preservado (resolve a linha ativa por
-- (user, dia); nenhum sessionId novo é exigido). Enforce N atômico.
-- =============================================================================
DROP FUNCTION IF EXISTS public.reserve_pronunciation_training_assessment(date, text, uuid);

CREATE OR REPLACE FUNCTION public.reserve_pronunciation_training_assessment(
  p_practice_date    date,
  p_azure_region     text,
  p_attempt_id       uuid,
  p_effective_limit  integer,
  p_unlimited        boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id        UUID;
  v_id             UUID;
  v_status         TEXT;
  v_active_attempt UUID;
  v_generated_text TEXT;
  v_consumed       INTEGER;
  v_completed      INTEGER;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  IF p_attempt_id IS NULL THEN
    RETURN jsonb_build_object('error', 'INVALID_ATTEMPT_ID');
  END IF;

  -- Trava a única linha ativa do dia (invariante do índice parcial). Reservas
  -- concorrentes serializam aqui; 'completed' só cresce via complete (que exige
  -- ter passado por 'processing'), então duas reservas perto do limite não
  -- passam ambas.
  SELECT id, status, active_attempt_id, generated_text
  INTO   v_id, v_status, v_active_attempt, v_generated_text
  FROM   pronunciation_training_sessions
  WHERE  user_id = v_user_id AND practice_date = p_practice_date AND status <> 'completed'
  FOR UPDATE
  LIMIT  1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'TEXT_NOT_GENERATED');
  END IF;

  -- Slots já consumidos hoje: reservados em andamento (processing) + concluídos.
  -- Mesmo espírito de writing_review_reservations: um slot 'reservado' conta
  -- imediatamente, antes mesmo da análise terminar.
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
        -- Mesma tentativa reconsultando (ex.: token expirado): idempotente.
        RETURN jsonb_build_object('action', 'existing_processing', 'sessionId', v_id, 'referenceText', v_generated_text, 'dailyCompleted', v_completed);
      ELSE
        RETURN jsonb_build_object('error', 'ASSESSMENT_IN_PROGRESS', 'sessionId', v_id);
      END IF;

    ELSE
      RETURN jsonb_build_object('error', 'ASSESSMENT_UNAVAILABLE');

  END CASE;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_pronunciation_training_assessment(date, text, uuid, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reserve_pronunciation_training_assessment(date, text, uuid, integer, boolean) TO anon;
GRANT EXECUTE ON FUNCTION public.reserve_pronunciation_training_assessment(date, text, uuid, integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_pronunciation_training_assessment(date, text, uuid, integer, boolean) TO service_role;

-- =============================================================================
-- complete_pronunciation_training_assessment — mesma assinatura, apenas passa a
-- retornar dailyCompleted (contagem de concluídas após esta) para o contador.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.complete_pronunciation_training_assessment(
  p_session_id uuid, p_attempt_id uuid,
  p_pronunciation_score numeric, p_accuracy_score numeric, p_fluency_score numeric,
  p_completeness_score numeric, p_prosody_score numeric, p_recognized_text text,
  p_words_json jsonb, p_raw_result_json jsonb, p_audio_duration_s numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id       UUID;
  v_status        TEXT;
  v_attempt       UUID;
  v_practice_date DATE;
  v_completed     INTEGER;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  SELECT status, active_attempt_id, practice_date
  INTO   v_status, v_attempt, v_practice_date
  FROM   pronunciation_training_sessions
  WHERE  id = p_session_id AND user_id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'NOT_FOUND');
  END IF;

  IF v_status = 'completed' AND v_attempt = p_attempt_id THEN
    SELECT count(*) INTO v_completed FROM pronunciation_training_sessions
      WHERE user_id = v_user_id AND practice_date = v_practice_date AND status = 'completed';
    RETURN jsonb_build_object('action', 'already_completed', 'dailyCompleted', v_completed);
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

  UPDATE pronunciation_training_sessions
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
   WHERE id                = p_session_id
     AND user_id           = v_user_id
     AND status            = 'processing'
     AND active_attempt_id = p_attempt_id;

  SELECT count(*) INTO v_completed FROM pronunciation_training_sessions
    WHERE user_id = v_user_id AND practice_date = v_practice_date AND status = 'completed';

  RETURN jsonb_build_object('action', 'completed', 'dailyCompleted', v_completed);
END;
$$;

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
