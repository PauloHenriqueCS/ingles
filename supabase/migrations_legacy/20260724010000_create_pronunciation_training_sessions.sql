-- =============================================================================
-- MIGRATION: 20260724010000_create_pronunciation_training_sessions
-- Projeto: Lemon (english learning app)
--
-- Etapa: limites de plano no Treino de Pronuncia (PronunciationTrainingView).
--
-- Ate esta migration, o fluxo standalone de treino de pronuncia
-- (api/pronunciation-training/generate-text + a analise oficial feita
-- inteiramente no cliente) nao tinha nenhuma persistencia nem limite
-- server-side: cada chamada a generate-text gerava um texto novo via IA sem
-- checar quantos ja foram gerados no dia, e o envio para analise chamava o
-- Azure Speech diretamente do browser sem nunca reservar uma vaga, validar a
-- duracao da gravacao no servidor, nem salvar o resultado -- um reload
-- perdia tudo e nada impedia reenvios ou cliques duplicados.
--
-- Esta tabela e as funcoes abaixo espelham deliberadamente o padrao atomico
-- ja usado por public.pronunciation_assessments / reserve_pronunciation_
-- assessment / complete_pronunciation_assessment / fail_pronunciation_
-- assessment / compensate_pronunciation_assessment (fluxo de pronuncia da
-- escrita, ligado a text_version_id/english_reviews) -- reservar->completar/
-- falhar, idempotencia por active_attempt_id, SECURITY DEFINER com
-- search_path fixo, auth.uid() validado dentro da funcao. Nao e a MESMA
-- tabela porque o dominio e diferente (texto de treino gerado por IA, sem
-- vinculo com nenhum english_reviews) e porque a chave natural aqui e
-- (user_id, practice_date) em vez de text_version_id -- no maximo uma sessao
-- de treino por usuario por dia (fuso America/Sao_Paulo, calculado no
-- backend com getTodaySP(), nunca no banco, para usar o mesmo relogio que
-- o resto do app).
--
-- Diferenca de comportamento deliberada em relacao ao padrao reutilizado:
-- reserve_pronunciation_assessment permite reiniciar uma avaliacao
-- 'completed' (o fluxo de escrita permite reavaliar a pronuncia quantas
-- vezes o usuario quiser). reserve_pronunciation_training_assessment NUNCA
-- permite isso -- uma sessao 'completed' e terminal ate a virada do dia,
-- exatamente como pedido ("depois de uma analise concluida, bloquear
-- qualquer novo envio no mesmo dia").
--
-- Nenhum dado de outra funcionalidade (escrita, listening, conversacao) e
-- tocado por esta migration.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.pronunciation_training_sessions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid NOT NULL REFERENCES auth.users(id),
  practice_date          date NOT NULL,
  level                  text NOT NULL,
  generated_text         text NOT NULL,
  status                 text NOT NULL DEFAULT 'text_generated',
  language_code          text NOT NULL DEFAULT 'en-US',
  azure_region           text NULL,
  pronunciation_score    numeric NULL,
  accuracy_score         numeric NULL,
  fluency_score          numeric NULL,
  completeness_score     numeric NULL,
  prosody_score          numeric NULL,
  recognized_text        text NULL,
  words_json             jsonb NULL,
  raw_result_json        jsonb NULL,
  audio_duration_seconds numeric NULL,
  error_code             text NULL,
  error_message          text NULL,
  active_attempt_id      uuid NULL,
  attempt_started_at     timestamptz NULL,
  started_at             timestamptz NULL,
  completed_at           timestamptz NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_pts_status CHECK (status IN ('text_generated', 'processing', 'completed', 'failed_retryable', 'failed_final')),
  CONSTRAINT uq_pts_user_date UNIQUE (user_id, practice_date)
);

COMMENT ON TABLE public.pronunciation_training_sessions IS
  'No maximo uma linha por usuario por dia (fuso America/Sao_Paulo) -- fonte de verdade do texto diario de Treino de Pronuncia e da sua unica analise oficial permitida. Nunca escrita diretamente por PostgREST; toda mutacao passa pelas funcoes create_pronunciation_training_text / reserve_pronunciation_training_assessment / complete_pronunciation_training_assessment / fail_pronunciation_training_assessment / compensate_pronunciation_training_assessment.';

CREATE INDEX IF NOT EXISTS idx_pts_user_date ON public.pronunciation_training_sessions (user_id, practice_date);

DROP TRIGGER IF EXISTS trg_pts_updated_at ON public.pronunciation_training_sessions;
CREATE TRIGGER trg_pts_updated_at
  BEFORE UPDATE ON public.pronunciation_training_sessions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS: mesmo padrao de public.pronunciation_assessments -- o usuario le a
-- propria linha diretamente (pa_select), mas nunca insere/atualiza via
-- PostgREST; toda escrita acontece dentro das funcoes SECURITY DEFINER
-- abaixo, que validam auth.uid() explicitamente.
ALTER TABLE public.pronunciation_training_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pts_select ON public.pronunciation_training_sessions;
CREATE POLICY pts_select
  ON public.pronunciation_training_sessions
  FOR SELECT
  TO public
  USING (auth.uid() = user_id);

REVOKE ALL ON public.pronunciation_training_sessions FROM anon;

-- =============================================================================
-- create_pronunciation_training_text — get-or-create do texto do dia
-- =============================================================================
-- Chamada depois que o backend ja gerou um texto via IA (a chamada de IA em
-- si nunca pode acontecer dentro do Postgres). Insercao atomica: se outra
-- requisicao concorrente ja criou a sessao de hoje primeiro, o texto recem-
-- gerado por esta chamada e descartado silenciosamente e a linha vencedora e
-- retornada -- nunca duas sessoes no mesmo dia, mesmo sob corrida real.
CREATE OR REPLACE FUNCTION public.create_pronunciation_training_text(
  p_practice_date date,
  p_level text,
  p_generated_text text
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

REVOKE ALL ON FUNCTION public.create_pronunciation_training_text(date, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_pronunciation_training_text(date, text, text) TO authenticated;

-- =============================================================================
-- reserve_pronunciation_training_assessment — reserva atomica do envio oficial
-- =============================================================================
-- Diferenca deliberada do padrao reutilizado (reserve_pronunciation_
-- assessment): status 'completed' NUNCA reinicia aqui -- retorna
-- DAILY_LIMIT_REACHED. Uma vez concluida, a analise do dia e terminal.
CREATE OR REPLACE FUNCTION public.reserve_pronunciation_training_assessment(
  p_practice_date date,
  p_azure_region text,
  p_attempt_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id        UUID;
  v_id             UUID;
  v_status         TEXT;
  v_active_attempt UUID;
  v_generated_text TEXT;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHORIZED');
  END IF;

  IF p_attempt_id IS NULL THEN
    RETURN jsonb_build_object('error', 'INVALID_ATTEMPT_ID');
  END IF;

  SELECT id, status, active_attempt_id, generated_text
  INTO   v_id, v_status, v_active_attempt, v_generated_text
  FROM   pronunciation_training_sessions
  WHERE  user_id = v_user_id AND practice_date = p_practice_date
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'TEXT_NOT_GENERATED');
  END IF;

  CASE v_status

    WHEN 'text_generated', 'failed_retryable', 'failed_final' THEN
      UPDATE pronunciation_training_sessions
         SET status             = 'processing',
             started_at         = NOW(),
             active_attempt_id  = p_attempt_id,
             attempt_started_at = NOW(),
             azure_region       = p_azure_region,
             error_code         = NULL,
             error_message      = NULL
       WHERE id = v_id;

      RETURN jsonb_build_object('action', 'reserved', 'sessionId', v_id, 'referenceText', v_generated_text);

    WHEN 'processing' THEN
      IF v_active_attempt = p_attempt_id THEN
        -- Mesma tentativa reconsultando (ex.: token expirado): idempotente.
        RETURN jsonb_build_object('action', 'existing_processing', 'sessionId', v_id, 'referenceText', v_generated_text);
      ELSE
        RETURN jsonb_build_object('error', 'ASSESSMENT_IN_PROGRESS', 'sessionId', v_id);
      END IF;

    WHEN 'completed' THEN
      -- Regra obrigatoria: nao ha reinicio depois de concluida. Bloqueio
      -- termina apenas na virada do dia (nova practice_date).
      RETURN jsonb_build_object('error', 'DAILY_LIMIT_REACHED', 'sessionId', v_id);

    ELSE
      RETURN jsonb_build_object('error', 'ASSESSMENT_UNAVAILABLE');

  END CASE;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_pronunciation_training_assessment(date, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reserve_pronunciation_training_assessment(date, text, uuid) TO authenticated;

-- =============================================================================
-- complete_pronunciation_training_assessment
-- =============================================================================
CREATE OR REPLACE FUNCTION public.complete_pronunciation_training_assessment(
  p_session_id uuid,
  p_attempt_id uuid,
  p_pronunciation_score numeric,
  p_accuracy_score numeric,
  p_fluency_score numeric,
  p_completeness_score numeric,
  p_prosody_score numeric,
  p_recognized_text text,
  p_words_json jsonb,
  p_raw_result_json jsonb,
  p_audio_duration_s numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
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
  FROM   pronunciation_training_sessions
  WHERE  id = p_session_id AND user_id = v_user_id
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

  RETURN jsonb_build_object('action', 'completed');
END;
$$;

REVOKE ALL ON FUNCTION public.complete_pronunciation_training_assessment(uuid, uuid, numeric, numeric, numeric, numeric, numeric, text, jsonb, jsonb, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_pronunciation_training_assessment(uuid, uuid, numeric, numeric, numeric, numeric, numeric, text, jsonb, jsonb, numeric) TO authenticated;

-- =============================================================================
-- fail_pronunciation_training_assessment
-- =============================================================================
-- Mais simples que fail_pronunciation_assessment: como 'completed' nunca
-- reinicia (ver reserve acima), nao existe cenario de "restaurar score
-- anterior" aqui -- toda linha que chega em 'processing' partiu de
-- text_generated/failed_retryable/failed_final, nunca teve score.
CREATE OR REPLACE FUNCTION public.fail_pronunciation_training_assessment(
  p_session_id uuid,
  p_attempt_id uuid,
  p_error_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
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
  FROM   pronunciation_training_sessions
  WHERE  id = p_session_id AND user_id = v_user_id
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

  UPDATE pronunciation_training_sessions
     SET status             = 'failed_retryable',
         active_attempt_id  = NULL,
         attempt_started_at = NULL,
         error_code         = p_error_code,
         error_message      = CASE p_error_code
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
   WHERE id      = p_session_id
     AND user_id = v_user_id;

  RETURN jsonb_build_object('action', 'failed_retryable');
END;
$$;

REVOKE ALL ON FUNCTION public.fail_pronunciation_training_assessment(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fail_pronunciation_training_assessment(uuid, uuid, text) TO authenticated;

-- =============================================================================
-- compensate_pronunciation_training_assessment
-- =============================================================================
-- Usada quando a emissao do token Azure falha logo apos reservar (mesmo
-- papel de compensate_pronunciation_assessment): libera a vaga sem exigir
-- attempt_id, pois o token nunca chegou a existir no lado do cliente.
CREATE OR REPLACE FUNCTION public.compensate_pronunciation_training_assessment(
  p_session_id uuid,
  p_error_code text,
  p_error_message text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE pronunciation_training_sessions
     SET status        = 'failed_retryable',
         error_code    = p_error_code,
         error_message = p_error_message
   WHERE id      = p_session_id
     AND user_id = v_user_id
     AND status  = 'processing';
END;
$$;

REVOKE ALL ON FUNCTION public.compensate_pronunciation_training_assessment(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.compensate_pronunciation_training_assessment(uuid, text, text) TO authenticated;

-- =============================================================================
-- VALIDACAO INLINE
-- =============================================================================

DO $$
DECLARE
  v_anon BOOLEAN;
BEGIN
  v_anon := has_table_privilege('anon', 'public.pronunciation_training_sessions', 'SELECT,INSERT,UPDATE,DELETE');
  IF v_anon THEN
    RAISE EXCEPTION 'VALIDATION FAILED: anon still holds a privilege on pronunciation_training_sessions';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.relname = 'pronunciation_training_sessions' AND c.relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'VALIDATION FAILED: RLS is not enabled on pronunciation_training_sessions';
  END IF;

  RAISE NOTICE 'VALIDATION PASSED: pronunciation_training_sessions created with RLS, anon stripped, one-row-per-user-per-day constraint in place';
END $$;

COMMIT;

-- =============================================================================
-- FIM DA MIGRATION 20260724010000_create_pronunciation_training_sessions
-- =============================================================================
