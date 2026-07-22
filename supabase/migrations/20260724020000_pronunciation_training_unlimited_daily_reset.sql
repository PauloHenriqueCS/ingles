-- =============================================================================
-- MIGRATION: 20260724020000_pronunciation_training_unlimited_daily_reset
-- Projeto: Lemon (english learning app)
--
-- BUG CORRIGIDO: "Treinar a Pronuncia" (PronunciationTrainingView) bloqueava
-- uma nova rodada no mesmo dia assim que a sessao do dia ficava 'completed',
-- SEM NUNCA consultar pronunciation.evaluations_per_day.unlimited -- ao
-- contrario do restante do fluxo de entitlements, que sempre trata unlimited
-- como fonte de verdade (ver plan-entitlements-service.ts). Uma conta com
-- "Treinar a Pronuncia" ilimitado terminava a primeira rodada do dia e, ao
-- tentar treinar de novo, recebia DAILY_LIMIT_REACHED de
-- reserve_pronunciation_training_assessment -- indistinguivel, para o
-- usuario, de um limite de plano realmente esgotado.
--
-- Correcao (escopo estrito: apenas create_pronunciation_training_text, apenas
-- o fluxo de Treino de Pronuncia -- nao toca pronunciation_assessments nem
-- reserve/complete/fail_pronunciation_training_assessment):
--   create_pronunciation_training_text ganha p_force_new boolean (default
--   false, retrocompativel -- toda chamada existente continua com o
--   comportamento exato de get-or-create de hoje). Quando o backend (nunca o
--   cliente diretamente -- ver api/pronunciation-training/[...slug].ts,
--   handleGenerateText) resolve server-side que o usuario tem
--   pronunciation.evaluations_per_day.unlimited = true E a sessao de hoje ja
--   esta 'completed' E o usuario pediu explicitamente uma nova rodada
--   (forceNew no corpo da requisicao), a funcao reseta a MESMA linha do dia
--   (mesma user_id+practice_date, dentro do unique constraint uq_pts_user_date
--   ja existente -- nenhuma mudanca de schema) de volta para
--   'text_generated' com o novo texto gerado, limpando o resultado anterior.
--   reserve_pronunciation_training_assessment ja aceita 'text_generated' como
--   estado reservavel (branch existente, nao alterada) -- entao /start volta
--   a funcionar normalmente para a nova rodada sem nenhuma mudanca naquela
--   funcao.
--
-- Concorrencia: o UPDATE abaixo so afeta a linha quando status = 'completed'
-- no momento exato da execucao (mesma garantia atomica que o restante deste
-- arquivo). Duas chamadas force_new concorrentes: a primeira reseta a linha;
-- a segunda nao encontra mais status='completed', cai no INSERT ... ON
-- CONFLICT DO NOTHING (linha ja existe) e a SELECT final devolve a rodada
-- vencedora da primeira chamada -- nunca duas rodadas simultaneas, mesmo sob
-- corrida real.
--
-- Planos limitados (unlimited=false): p_force_new nunca chega como true para
-- esses usuarios (decidido em Node a partir do entitlements resolvido
-- server-side, nunca de um valor enviado pelo cliente) -- o comportamento de
-- "uma unica sessao terminal por dia" continua exatamente como antes.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.create_pronunciation_training_text(
  p_practice_date date,
  p_level text,
  p_generated_text text,
  p_force_new boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id UUID;
  v_row     RECORD;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  IF p_generated_text IS NULL OR length(trim(p_generated_text)) = 0 THEN
    RETURN jsonb_build_object('error', 'INVALID_TEXT');
  END IF;

  -- Unlimited-plan reset: only ever takes effect when today's row is
  -- genuinely 'completed'. If it is not (already reset by a winning
  -- concurrent call, still 'processing', or never existed), this UPDATE
  -- affects zero rows and the INSERT ... ON CONFLICT DO NOTHING below is the
  -- one that applies -- never a destructive no-op turned into data loss.
  IF p_force_new THEN
    UPDATE pronunciation_training_sessions
       SET level                  = p_level,
           generated_text         = p_generated_text,
           status                 = 'text_generated',
           pronunciation_score    = NULL,
           accuracy_score         = NULL,
           fluency_score          = NULL,
           completeness_score     = NULL,
           prosody_score          = NULL,
           recognized_text        = NULL,
           words_json             = NULL,
           raw_result_json        = NULL,
           audio_duration_seconds = NULL,
           error_code             = NULL,
           error_message          = NULL,
           active_attempt_id      = NULL,
           attempt_started_at     = NULL,
           started_at             = NULL,
           completed_at           = NULL
     WHERE user_id = v_user_id AND practice_date = p_practice_date AND status = 'completed';
  END IF;

  INSERT INTO pronunciation_training_sessions (user_id, practice_date, level, generated_text, status)
  VALUES (v_user_id, p_practice_date, p_level, p_generated_text, 'text_generated')
  ON CONFLICT ON CONSTRAINT uq_pts_user_date DO NOTHING;

  SELECT id, level, generated_text, status,
         pronunciation_score, accuracy_score, fluency_score, completeness_score, prosody_score,
         recognized_text, words_json, raw_result_json, audio_duration_seconds
  INTO   v_row
  FROM   pronunciation_training_sessions
  WHERE  user_id = v_user_id AND practice_date = p_practice_date;

  RETURN jsonb_build_object(
    'sessionId',    v_row.id,
    'level',        v_row.level,
    'text',         v_row.generated_text,
    'status',       v_row.status,
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

REVOKE ALL ON FUNCTION public.create_pronunciation_training_text(date, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_pronunciation_training_text(date, text, text, boolean) TO authenticated;

-- The old 3-arg overload is superseded by the 4-arg version (p_force_new
-- DEFAULT false makes every existing call site source-compatible without
-- changes to callers that omit it) -- drop it so PostgREST/RPC callers never
-- resolve to a stale signature.
DROP FUNCTION IF EXISTS public.create_pronunciation_training_text(date, text, text);

-- =============================================================================
-- VALIDACAO INLINE
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'create_pronunciation_training_text'
      AND pg_get_function_identity_arguments(p.oid) = 'p_practice_date date, p_level text, p_generated_text text, p_force_new boolean'
  ) THEN
    RAISE EXCEPTION 'VALIDATION FAILED: create_pronunciation_training_text(date, text, text, boolean) not found';
  END IF;

  RAISE NOTICE 'VALIDATION PASSED: create_pronunciation_training_text accepts p_force_new for unlimited-plan same-day resets';
END $$;

COMMIT;

-- =============================================================================
-- FIM DA MIGRATION 20260724020000_pronunciation_training_unlimited_daily_reset
-- =============================================================================
