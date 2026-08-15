-- =============================================================================
-- MIGRATION: 20260815122000_pronunciation_text_curricular_identity
-- Projeto: Orodim
--
-- Aplicada automaticamente por deploy-production.yml / homologation.yml
-- (supabase db push). Não aplicar manualmente no SQL Editor.
--
-- OBJETIVO (ROOT-1): a identidade curricular da sessão de treino de pronúncia
-- (curriculum_version_id + curriculum_subtopic_key) passa a ser persistida NA
-- MESMA operação atômica que CRIA a pronunciation_training_session, dentro de
-- create_pronunciation_training_text — eliminando o UPDATE best-effort pós-RPC
-- (cuja falha era engolida e não checava `{ error }`). Assim uma sessão de
-- pronúncia curricular nunca nasce sem identidade durável.
--
-- Reuso: uma linha ATIVA/COMPLETED já existente devolve a sua identidade
-- ORIGINAL — a nova identidade só é gravada quando a linha é CRIADA (nunca
-- sobrescreve; nunca troca de recorte silenciosamente). Uma linha legada sem
-- identidade continua devolvendo NULL (o chamador a trata como NÃO creditável,
-- jamais usando o pointer atual como fallback).
--
-- ASSINATURA: substitui a de 6 args pela de 8 (drop explícito + create + re-grant
-- idêntico — nunca amplia permissões). O único chamador vivo é
-- api/pronunciation-training/[...slug].ts, atualizado no mesmo patch.
--
-- COMPATIBILIDADE: aditivo/seguro. Colunas curriculum_version_id/
-- curriculum_subtopic_key já existem (20260815121100). Preserva SECURITY
-- DEFINER, search_path, RLS e grants.
-- =============================================================================
DROP FUNCTION IF EXISTS public.create_pronunciation_training_text(date, text, text, boolean, integer, boolean);

CREATE OR REPLACE FUNCTION public.create_pronunciation_training_text(
  p_practice_date          date,
  p_level                  text,
  p_generated_text         text,
  p_start_new_round        boolean,
  p_effective_limit        integer,
  p_unlimited              boolean,
  p_curriculum_version_id  uuid,
  p_curriculum_subtopic_key text
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

  -- (1) Linha ATIVA existente: recarregar devolve ela — com a identidade ORIGINAL.
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
      -- (2) Última concluída (com a sua identidade ORIGINAL).
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
      -- (3) Criar nova rodada com a identidade curricular NA MESMA OPERAÇÃO.
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
    -- Identidade curricular DURÁVEL da sessão devolvida (NULL só para linha
    -- legada criada antes desta migração — o chamador a trata como não creditável).
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
$$;

REVOKE ALL ON FUNCTION public.create_pronunciation_training_text(date, text, text, boolean, integer, boolean, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_pronunciation_training_text(date, text, text, boolean, integer, boolean, uuid, text) TO anon;
GRANT EXECUTE ON FUNCTION public.create_pronunciation_training_text(date, text, text, boolean, integer, boolean, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_pronunciation_training_text(date, text, text, boolean, integer, boolean, uuid, text) TO service_role;

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
