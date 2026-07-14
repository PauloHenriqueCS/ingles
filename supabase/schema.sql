-- =============================================================================
-- SCHEMA CANÔNICO — Lemon (english learning app)
-- Estado final após todas as migrations até 20260714120000 (inclusive).
--
-- USO:
--   Banco novo (vazio): execute este arquivo para criar a estrutura completa.
--   Banco existente em produção: NÃO execute. Use apenas supabase/migrations/.
--
-- Para dúvidas sobre qual arquivo aplicar em qual situação, consulte:
--   supabase/MIGRATIONS.md
-- =============================================================================

-- =============================================================================
-- FUNÇÕES UTILITÁRIAS (trigger helpers)
-- =============================================================================

-- Atualiza updated_at automaticamente em qualquer linha modificada.
-- Usada pelos triggers de writing_entries.
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- Variante idêntica para pronunciation_assessments (declarada separadamente
-- por razões históricas; mantida para não alterar assinaturas de triggers).
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- =============================================================================
-- writing_entries
-- Diário de escrita do usuário. Uma entrada por data por usuário.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.writing_entries (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_date            DATE         NOT NULL,
  month                 INTEGER      NOT NULL,
  year                  INTEGER      NOT NULL,
  theme                 TEXT         NOT NULL DEFAULT '',
  grammar_goal          TEXT,
  main_tense            TEXT,
  title                 TEXT,
  original_text         TEXT,
  corrected_text        TEXT,
  notes                 TEXT,
  main_errors           TEXT,
  difficulty            TEXT         CHECK (difficulty IN ('facil', 'medio', 'dificil') OR difficulty IS NULL),
  status                TEXT         NOT NULL DEFAULT 'nao-iniciado'
                                     CHECK (status IN ('nao-iniciado', 'escrito', 'corrigido', 'revisado')),
  word_count            INTEGER      NOT NULL DEFAULT 0,
  -- Colunas adicionadas em migration_multiuser:
  user_id               UUID         REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Coluna adicionada em migration_add_ai_review:
  ai_review             JSONB,
  -- Colunas adicionadas em migration_v2_ai_columns:
  ai_score              INTEGER,
  cefr_level            TEXT,
  grammar_score         INTEGER,
  vocabulary_score      INTEGER,
  naturalness_score     INTEGER,
  fluency_score         INTEGER,
  ai_summary            TEXT,
  grammar_feedback      JSONB,
  ai_main_errors        JSONB,
  new_vocabulary        JSONB,
  natural_expressions   JSONB,
  grammar_goal_achieved BOOLEAN,
  rewrite_challenge     TEXT,
  reviewed_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE public.writing_entries ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS writing_entries_year_month_idx
  ON public.writing_entries (year, month);

CREATE INDEX IF NOT EXISTS writing_entries_user_id_idx
  ON public.writing_entries (user_id);

CREATE INDEX IF NOT EXISTS writing_entries_user_date_idx
  ON public.writing_entries (user_id, entry_date DESC);

-- Garante que cada usuário tenha no máximo uma entrada por data.
CREATE UNIQUE INDEX IF NOT EXISTS writing_entries_user_entry_date_unique
  ON public.writing_entries (user_id, entry_date);

DROP TRIGGER IF EXISTS writing_entries_updated_at ON public.writing_entries;
CREATE TRIGGER writing_entries_updated_at
  BEFORE UPDATE ON public.writing_entries
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- RLS: cada usuário acessa apenas as próprias entradas.
-- "anon_all" e "authenticated_all" (políticas inseguras de versões anteriores)
-- nunca devem existir aqui.
DROP POLICY IF EXISTS "anon_all"          ON public.writing_entries;
DROP POLICY IF EXISTS "authenticated_all" ON public.writing_entries;
DROP POLICY IF EXISTS "we_select"         ON public.writing_entries;
DROP POLICY IF EXISTS "we_insert"         ON public.writing_entries;
DROP POLICY IF EXISTS "we_update"         ON public.writing_entries;
DROP POLICY IF EXISTS "we_delete"         ON public.writing_entries;

CREATE POLICY "we_select" ON public.writing_entries
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "we_insert" ON public.writing_entries
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "we_update" ON public.writing_entries
  FOR UPDATE TO authenticated
  USING     (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "we_delete" ON public.writing_entries
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- =============================================================================
-- english_reviews
-- Avaliações de textos escritos pelo usuário geradas pela IA.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.english_reviews (
  id                          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  original_text               TEXT         NOT NULL,
  corrected_text              TEXT,
  score                       INTEGER      NOT NULL,
  level                       TEXT         NOT NULL,
  grammar                     INTEGER      NOT NULL DEFAULT 0,
  vocabulary                  INTEGER      NOT NULL DEFAULT 0,
  naturalness                 INTEGER      NOT NULL DEFAULT 0,
  fluency                     INTEGER      NOT NULL DEFAULT 0,
  summary                     TEXT,
  main_mistakes               JSONB        NOT NULL DEFAULT '[]',
  new_vocabulary              JSONB        NOT NULL DEFAULT '[]',
  objective_feedback          TEXT,
  next_practice               TEXT,
  category                    TEXT,
  difficulty                  TEXT,
  objective                   TEXT,
  -- Colunas adicionadas em migration_history_persistence:
  entry_date                  DATE,
  mission_snapshot            JSONB,
  version_2_text              TEXT,
  version_2_comparison        JSONB,
  version_2_improvement_score INTEGER,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE public.english_reviews ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS english_reviews_user_id_idx
  ON public.english_reviews (user_id);

CREATE INDEX IF NOT EXISTS english_reviews_user_created_idx
  ON public.english_reviews (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_english_reviews_user_entry_date
  ON public.english_reviews (user_id, entry_date);

DROP POLICY IF EXISTS "er_select" ON public.english_reviews;
DROP POLICY IF EXISTS "er_insert" ON public.english_reviews;
DROP POLICY IF EXISTS "er_update" ON public.english_reviews;
DROP POLICY IF EXISTS "er_delete" ON public.english_reviews;

CREATE POLICY "er_select" ON public.english_reviews
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "er_insert" ON public.english_reviews
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "er_update" ON public.english_reviews
  FOR UPDATE TO authenticated
  USING     (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "er_delete" ON public.english_reviews
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- =============================================================================
-- english_learning_memory
-- Memória acumulada de aprendizado: uma linha por usuário.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.english_learning_memory (
  id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID         NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  current_level           TEXT         NOT NULL DEFAULT 'A1',
  average_score           INTEGER      NOT NULL DEFAULT 0,
  weakest_skill           TEXT,
  strongest_skill         TEXT,
  recurring_mistakes      JSONB        NOT NULL DEFAULT '[]',
  grammar_focus           JSONB        NOT NULL DEFAULT '[]',
  vocabulary_learned      JSONB        NOT NULL DEFAULT '[]',
  vocabulary_to_review    JSONB        NOT NULL DEFAULT '[]',
  recommended_next_focus  TEXT,
  recommended_next_theme  TEXT,
  teacher_summary         TEXT,
  total_reviews           INTEGER      NOT NULL DEFAULT 0,
  practiced_days          INTEGER      NOT NULL DEFAULT 0,
  current_streak          INTEGER      NOT NULL DEFAULT 0,
  last_review_at          TIMESTAMPTZ,
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE public.english_learning_memory ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS english_learning_memory_user_idx
  ON public.english_learning_memory (user_id);

DROP POLICY IF EXISTS "elm_select" ON public.english_learning_memory;
DROP POLICY IF EXISTS "elm_insert" ON public.english_learning_memory;
DROP POLICY IF EXISTS "elm_update" ON public.english_learning_memory;
DROP POLICY IF EXISTS "elm_delete" ON public.english_learning_memory;

CREATE POLICY "elm_select" ON public.english_learning_memory
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "elm_insert" ON public.english_learning_memory
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "elm_update" ON public.english_learning_memory
  FOR UPDATE TO authenticated
  USING     (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "elm_delete" ON public.english_learning_memory
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- =============================================================================
-- grammar_explanations
-- Cache global de explicações gramaticais. Leitura/escrita para autenticados.
-- Não é tabela por usuário — sem coluna user_id.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.grammar_explanations (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT         NOT NULL,
  content    JSONB        NOT NULL,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Índice único case-insensitive impede duplicatas para o mesmo tópico.
CREATE UNIQUE INDEX IF NOT EXISTS grammar_explanations_name_lower_idx
  ON public.grammar_explanations (LOWER(name));

ALTER TABLE public.grammar_explanations ENABLE ROW LEVEL SECURITY;

-- "anon_all" nunca deve existir aqui (criada por migration_grammar_explanations.sql
-- em certas ordens de aplicação; removida por migration_multiuser.sql e por
-- migration 20260714120000).
DROP POLICY IF EXISTS "anon_all"  ON public.grammar_explanations;
DROP POLICY IF EXISTS "ge_select" ON public.grammar_explanations;
DROP POLICY IF EXISTS "ge_insert" ON public.grammar_explanations;
DROP POLICY IF EXISTS "ge_update" ON public.grammar_explanations;

CREATE POLICY "ge_select" ON public.grammar_explanations
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "ge_insert" ON public.grammar_explanations
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "ge_update" ON public.grammar_explanations
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- =============================================================================
-- generated_themes
-- Temas de escrita gerados pela IA, por usuário.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.generated_themes (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID         REFERENCES auth.users(id),
  title            TEXT         NOT NULL,
  description      TEXT,
  grammar_focus    TEXT[],
  activity_type    TEXT,
  context          TEXT,
  semantic_summary TEXT,
  difficulty       TEXT         CHECK (difficulty IN ('easy', 'medium', 'hard')),
  vocabulary       TEXT[],
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  status           TEXT         NOT NULL DEFAULT 'generated'
                               CHECK (status IN ('generated', 'completed', 'skipped', 'regenerated'))
);

ALTER TABLE public.generated_themes ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS generated_themes_user_created_idx
  ON public.generated_themes (user_id, created_at DESC);

DROP POLICY IF EXISTS "anon_all"  ON public.generated_themes;
DROP POLICY IF EXISTS "gt_select" ON public.generated_themes;
DROP POLICY IF EXISTS "gt_insert" ON public.generated_themes;
DROP POLICY IF EXISTS "gt_update" ON public.generated_themes;
DROP POLICY IF EXISTS "gt_delete" ON public.generated_themes;

CREATE POLICY "gt_select" ON public.generated_themes
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "gt_insert" ON public.generated_themes
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "gt_update" ON public.generated_themes
  FOR UPDATE TO authenticated
  USING     (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "gt_delete" ON public.generated_themes
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- =============================================================================
-- ai_conversation_preferences
-- Preferências do tutor de IA: uma linha por usuário.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.set_ai_prefs_user_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.user_id    := COALESCE(NEW.user_id, auth.uid());
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.ai_conversation_preferences (
  id                              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                         UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  teacher_name                    TEXT         NOT NULL DEFAULT 'Lemon AI',
  -- Colunas legacy mantidas por compatibilidade com dados existentes:
  personality                     TEXT         NOT NULL DEFAULT 'friendly'
                                               CHECK (personality IN ('friendly', 'professional', 'strict')),
  correction_style                TEXT         NOT NULL DEFAULT 'gentle'
                                               CHECK (correction_style IN ('gentle', 'direct')),
  voice                           TEXT         NOT NULL DEFAULT 'coral',
  focus_areas                     TEXT[]       NOT NULL DEFAULT '{}',
  -- Colunas adicionadas em migration_tutor_preferences:
  accent                          TEXT         NOT NULL DEFAULT 'american'
                                               CHECK (accent IN ('american', 'british', 'neutral')),
  speech_pace                     TEXT         NOT NULL DEFAULT 'slow'
                                               CHECK (speech_pace IN ('slow', 'normal', 'natural')),
  personality_preset              TEXT         NOT NULL DEFAULT 'patient'
                                               CHECK (personality_preset IN ('patient', 'friend', 'teacher', 'unfiltered_friend', 'custom')),
  formality                       TEXT         NOT NULL DEFAULT 'medium'
                                               CHECK (formality IN ('very_low', 'low', 'medium', 'high')),
  humor_level                     TEXT         NOT NULL DEFAULT 'low'
                                               CHECK (humor_level IN ('low', 'medium', 'high')),
  roast_intensity                 TEXT         NOT NULL DEFAULT 'off'
                                               CHECK (roast_intensity IN ('off', 'light', 'high')),
  profanity_enabled               BOOLEAN      NOT NULL DEFAULT FALSE,
  topic_initiative                TEXT         NOT NULL DEFAULT 'medium'
                                               CHECK (topic_initiative IN ('low', 'medium', 'high')),
  correction_timing               TEXT         NOT NULL DEFAULT 'after_each'
                                               CHECK (correction_timing IN ('after_each', 'end_of_block', 'session_summary')),
  correction_scope                TEXT         NOT NULL DEFAULT 'important_only'
                                               CHECK (correction_scope IN ('important_only', 'all_relevant', 'communication_impact')),
  correction_language             TEXT         NOT NULL DEFAULT 'portuguese'
                                               CHECK (correction_language IN ('portuguese', 'english')),
  correction_detail               TEXT         NOT NULL DEFAULT 'brief'
                                               CHECK (correction_detail IN ('brief', 'detailed')),
  -- Coluna adicionada em migration_conversation_goal:
  daily_conversation_goal_minutes INTEGER      NOT NULL DEFAULT 15
                                               CHECK (daily_conversation_goal_minutes IN (5, 10, 15, 20, 30)),
  created_at                      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_ai_prefs_per_user UNIQUE (user_id)
);

ALTER TABLE public.ai_conversation_preferences ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_ai_prefs_user_id ON public.ai_conversation_preferences;
CREATE TRIGGER trg_ai_prefs_user_id
  BEFORE INSERT OR UPDATE ON public.ai_conversation_preferences
  FOR EACH ROW EXECUTE FUNCTION public.set_ai_prefs_user_id();

DROP POLICY IF EXISTS "Users manage own AI preferences" ON public.ai_conversation_preferences;

CREATE POLICY "Users manage own AI preferences"
  ON public.ai_conversation_preferences
  FOR ALL
  USING     (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- =============================================================================
-- conversation_sessions
-- Sessões de conversação com IA: duração em segundos por data.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.set_conversation_session_user_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.user_id := COALESCE(NEW.user_id, auth.uid());
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.conversation_sessions (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_date DATE         NOT NULL,
  duration_sec INTEGER      NOT NULL CHECK (duration_sec > 0),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE public.conversation_sessions ENABLE ROW LEVEL SECURITY;

-- Índice composto: acelera getDayTotalSeconds(user_id, session_date).
CREATE INDEX IF NOT EXISTS idx_conversation_sessions_user_date
  ON public.conversation_sessions (user_id, session_date);

DROP TRIGGER IF EXISTS trg_conv_session_user_id ON public.conversation_sessions;
CREATE TRIGGER trg_conv_session_user_id
  BEFORE INSERT ON public.conversation_sessions
  FOR EACH ROW EXECUTE FUNCTION public.set_conversation_session_user_id();

DROP POLICY IF EXISTS "Users manage own conversation sessions" ON public.conversation_sessions;

CREATE POLICY "Users manage own conversation sessions"
  ON public.conversation_sessions
  FOR ALL
  USING     (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- =============================================================================
-- pronunciation_assessments
-- Avaliações de pronúncia via Azure Cognitive Services.
-- INSERT/UPDATE bloqueados via RLS — apenas RPCs SECURITY DEFINER escrevem.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.pronunciation_assessments (
  id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  text_version_id         UUID         NOT NULL REFERENCES public.english_reviews(id) ON DELETE CASCADE,
  status                  TEXT         NOT NULL DEFAULT 'processing'
                                       CHECK (status IN ('processing', 'completed', 'failed_retryable', 'failed_final')),
  reference_text          TEXT         NOT NULL,
  language_code           TEXT         NOT NULL DEFAULT 'en-US',
  azure_region            TEXT         NOT NULL,
  -- Scores NULL enquanto em processamento ou em caso de falha:
  pronunciation_score     NUMERIC(5,2) CHECK (pronunciation_score  IS NULL OR pronunciation_score  BETWEEN 0 AND 100),
  accuracy_score          NUMERIC(5,2) CHECK (accuracy_score       IS NULL OR accuracy_score       BETWEEN 0 AND 100),
  fluency_score           NUMERIC(5,2) CHECK (fluency_score        IS NULL OR fluency_score        BETWEEN 0 AND 100),
  completeness_score      NUMERIC(5,2) CHECK (completeness_score   IS NULL OR completeness_score   BETWEEN 0 AND 100),
  prosody_score           NUMERIC(5,2) CHECK (prosody_score        IS NULL OR prosody_score        BETWEEN 0 AND 100),
  recognized_text         TEXT,
  words_json              JSONB,
  raw_result_json         JSONB,
  audio_path              TEXT,
  audio_duration_seconds  NUMERIC(8,3),
  error_code              TEXT,
  error_message           TEXT,
  -- Colunas adicionadas em migration_pronunciation_step5:
  active_attempt_id       UUID,
  attempt_started_at      TIMESTAMPTZ,
  started_at              TIMESTAMPTZ,
  completed_at            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_pronunciation_per_text_version UNIQUE (user_id, text_version_id)
);

ALTER TABLE public.pronunciation_assessments ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_pronunciation_assessments_user
  ON public.pronunciation_assessments (user_id);

CREATE INDEX IF NOT EXISTS idx_pronunciation_assessments_text_version
  ON public.pronunciation_assessments (text_version_id);

DROP TRIGGER IF EXISTS pa_set_updated_at ON public.pronunciation_assessments;
CREATE TRIGGER pa_set_updated_at
  BEFORE UPDATE ON public.pronunciation_assessments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Somente SELECT pelo dono. INSERT/UPDATE somente via RPCs abaixo.
DROP POLICY IF EXISTS pa_select ON public.pronunciation_assessments;
CREATE POLICY pa_select ON public.pronunciation_assessments
  FOR SELECT USING (auth.uid() = user_id);

-- =============================================================================
-- RPCs de pronúncia (SECURITY DEFINER)
-- Versões finais: migration_pronunciation_start + step5 + unlimited_attempts
-- =============================================================================

-- Reserva ou reativa um assessment; versão sem attempt_id (migration_start).
-- Mantida para compatibilidade com compensate_pronunciation_assessment.
CREATE OR REPLACE FUNCTION public.compensate_pronunciation_assessment(
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
  UPDATE pronunciation_assessments
     SET status        = 'failed_retryable',
         error_code    = p_error_code,
         error_message = p_error_message
   WHERE id      = p_assessment_id
     AND user_id = v_user_id
     AND status  = 'processing';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.compensate_pronunciation_assessment(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.compensate_pronunciation_assessment(UUID, TEXT, TEXT) TO authenticated;

-- Versão com attempt_id (migration_pronunciation_unlimited_attempts — versão final).
CREATE OR REPLACE FUNCTION public.reserve_pronunciation_assessment(
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

  SELECT id, status, active_attempt_id
  INTO   v_id, v_status, v_active_attempt
  FROM   pronunciation_assessments
  WHERE  user_id         = v_user_id
    AND  text_version_id = p_text_version_id
  FOR UPDATE;

  IF v_rows_inserted = 1 THEN
    RETURN jsonb_build_object(
      'action', 'created', 'assessmentId', v_id, 'referenceText', v_reference_text
    );
  END IF;

  CASE v_status
    WHEN 'processing' THEN
      IF v_active_attempt = p_attempt_id THEN
        RETURN jsonb_build_object(
          'action', 'existing_processing', 'assessmentId', v_id, 'referenceText', v_reference_text
        );
      ELSE
        RETURN jsonb_build_object('error', 'ASSESSMENT_IN_PROGRESS', 'assessmentId', v_id);
      END IF;

    WHEN 'failed_retryable', 'failed_final' THEN
      UPDATE pronunciation_assessments
         SET status = 'processing', started_at = NOW(),
             active_attempt_id = p_attempt_id, attempt_started_at = NOW(),
             error_code = NULL, error_message = NULL
       WHERE id = v_id AND user_id = v_user_id;
      RETURN jsonb_build_object(
        'action', 'reactivated', 'assessmentId', v_id, 'referenceText', v_reference_text
      );

    WHEN 'completed' THEN
      UPDATE pronunciation_assessments
         SET status = 'processing', started_at = NOW(),
             active_attempt_id = p_attempt_id, attempt_started_at = NOW(),
             error_code = NULL, error_message = NULL
       WHERE id = v_id AND user_id = v_user_id;
      RETURN jsonb_build_object(
        'action', 'restarted', 'assessmentId', v_id, 'referenceText', v_reference_text
      );

    ELSE
      RETURN jsonb_build_object('error', 'ASSESSMENT_UNAVAILABLE');
  END CASE;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reserve_pronunciation_assessment(UUID, TEXT, UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.reserve_pronunciation_assessment(UUID, TEXT, UUID) TO authenticated;

-- Conclui um assessment com os scores finais (migration_pronunciation_step5).
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
  WHERE  id = p_assessment_id AND user_id = v_user_id
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

REVOKE EXECUTE ON FUNCTION public.complete_pronunciation_assessment(UUID, UUID, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, JSONB, JSONB, NUMERIC) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.complete_pronunciation_assessment(UUID, UUID, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, JSONB, JSONB, NUMERIC) TO authenticated;

-- Marca assessment como falho; restaura resultado anterior se existir
-- (migration_pronunciation_unlimited_attempts — versão final).
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
           WHEN 'AZURE_NO_MATCH'      THEN 'O Azure não reconheceu fala no áudio.'
           WHEN 'AZURE_CANCELED'      THEN 'A análise foi cancelada pelo serviço.'
           WHEN 'AZURE_TIMEOUT'       THEN 'O serviço de pronúncia demorou para responder.'
           WHEN 'AZURE_NETWORK_ERROR' THEN 'Erro de rede durante a análise de pronúncia.'
           WHEN 'RESULT_INVALID'      THEN 'O resultado retornado pelo serviço é inválido.'
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

-- =============================================================================
-- review_groups
-- Grupos de palavras/estruturas para revisão espaçada (Spaced Repetition).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.review_groups (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_review_id  UUID         NOT NULL REFERENCES public.english_reviews(id) ON DELETE CASCADE,
  source_entry_date DATE,
  original_theme    TEXT,
  status            TEXT         NOT NULL DEFAULT 'scheduled'
                                 CHECK (status IN ('scheduled', 'active', 'mastered')),
  review_level      INTEGER      NOT NULL DEFAULT 0
                                 CONSTRAINT review_groups_level_non_negative CHECK (review_level >= 0),
  next_review_at    TIMESTAMPTZ, -- NULL para status 'mastered' (migration_review_schedule)
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT review_groups_user_review_unique UNIQUE (user_id, source_review_id)
);

ALTER TABLE public.review_groups ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS review_groups_user_id_idx
  ON public.review_groups (user_id);

CREATE INDEX IF NOT EXISTS review_groups_user_next_review_idx
  ON public.review_groups (user_id, next_review_at);

DROP POLICY IF EXISTS "rg_select" ON public.review_groups;
DROP POLICY IF EXISTS "rg_insert" ON public.review_groups;
DROP POLICY IF EXISTS "rg_update" ON public.review_groups;
DROP POLICY IF EXISTS "rg_delete" ON public.review_groups;

CREATE POLICY "rg_select" ON public.review_groups
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "rg_insert" ON public.review_groups
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "rg_update" ON public.review_groups
  FOR UPDATE TO authenticated
  USING     (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "rg_delete" ON public.review_groups
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- =============================================================================
-- review_group_items
-- Itens (palavras/estruturas) dentro de cada grupo de revisão.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.review_group_items (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  review_group_id   UUID         NOT NULL REFERENCES public.review_groups(id) ON DELETE CASCADE,
  original_value    TEXT         NOT NULL,
  corrected_value   TEXT         NOT NULL,
  explanation       TEXT,
  original_sentence TEXT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE public.review_group_items ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS review_group_items_group_idx
  ON public.review_group_items (review_group_id);

DROP POLICY IF EXISTS "rgi_select" ON public.review_group_items;
DROP POLICY IF EXISTS "rgi_insert" ON public.review_group_items;
DROP POLICY IF EXISTS "rgi_delete" ON public.review_group_items;

CREATE POLICY "rgi_select" ON public.review_group_items
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.review_groups rg
            WHERE rg.id = review_group_id AND rg.user_id = auth.uid())
  );

CREATE POLICY "rgi_insert" ON public.review_group_items
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM public.review_groups rg
            WHERE rg.id = review_group_id AND rg.user_id = auth.uid())
  );

CREATE POLICY "rgi_delete" ON public.review_group_items
  FOR DELETE TO authenticated USING (
    EXISTS (SELECT 1 FROM public.review_groups rg
            WHERE rg.id = review_group_id AND rg.user_id = auth.uid())
  );

-- =============================================================================
-- review_attempts
-- Registro de tentativas de revisão pelo usuário.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.review_attempts (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  review_group_id   UUID         NOT NULL REFERENCES public.review_groups(id) ON DELETE CASCADE,
  source_entry_date DATE,
  submitted_text    TEXT,
  overall_result    TEXT         NOT NULL CHECK (overall_result IN ('passed', 'failed')),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE public.review_attempts ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS review_attempts_user_id_idx
  ON public.review_attempts (user_id);

CREATE INDEX IF NOT EXISTS review_attempts_group_id_idx
  ON public.review_attempts (review_group_id);

DROP POLICY IF EXISTS "ra_select" ON public.review_attempts;
DROP POLICY IF EXISTS "ra_insert" ON public.review_attempts;
DROP POLICY IF EXISTS "ra_delete" ON public.review_attempts;

CREATE POLICY "ra_select" ON public.review_attempts
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "ra_insert" ON public.review_attempts
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "ra_delete" ON public.review_attempts
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- =============================================================================
-- review_attempt_items
-- Avaliação de cada item dentro de uma tentativa de revisão.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.review_attempt_items (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  review_attempt_id    UUID         NOT NULL REFERENCES public.review_attempts(id) ON DELETE CASCADE,
  review_group_item_id UUID         REFERENCES public.review_group_items(id) ON DELETE SET NULL,
  required_word        TEXT         NOT NULL,
  status               TEXT         NOT NULL
                                    CHECK (status IN ('correct', 'incorrect_spelling', 'incorrect_usage', 'missing', 'forced_usage')),
  used_excerpt         TEXT,
  explanation          TEXT         NOT NULL,
  suggested_correction TEXT,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE public.review_attempt_items ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS review_attempt_items_attempt_idx
  ON public.review_attempt_items (review_attempt_id);

DROP POLICY IF EXISTS "rai_select" ON public.review_attempt_items;
DROP POLICY IF EXISTS "rai_insert" ON public.review_attempt_items;
DROP POLICY IF EXISTS "rai_delete" ON public.review_attempt_items;

CREATE POLICY "rai_select" ON public.review_attempt_items
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.review_attempts ra
            WHERE ra.id = review_attempt_id AND ra.user_id = auth.uid())
  );

CREATE POLICY "rai_insert" ON public.review_attempt_items
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM public.review_attempts ra
            WHERE ra.id = review_attempt_id AND ra.user_id = auth.uid())
  );

CREATE POLICY "rai_delete" ON public.review_attempt_items
  FOR DELETE TO authenticated USING (
    EXISTS (SELECT 1 FROM public.review_attempts ra
            WHERE ra.id = review_attempt_id AND ra.user_id = auth.uid())
  );

-- =============================================================================
-- review_schedule_history
-- Histórico imutável de cada transição de agendamento (idempotência via unique).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.review_schedule_history (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  review_group_id          UUID         NOT NULL REFERENCES public.review_groups(id) ON DELETE CASCADE,
  review_attempt_id        UUID         NOT NULL REFERENCES public.review_attempts(id) ON DELETE CASCADE,
  previous_level           INTEGER      NOT NULL,
  new_level                INTEGER      NOT NULL,
  overall_result           TEXT         NOT NULL,
  previous_status          TEXT         NOT NULL,
  new_status               TEXT         NOT NULL,
  previous_next_review_at  TIMESTAMPTZ,
  new_next_review_at       TIMESTAMPTZ,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (review_attempt_id) -- garante idempotência: uma entrada por tentativa
);

ALTER TABLE public.review_schedule_history ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS review_schedule_history_user_id_idx
  ON public.review_schedule_history (user_id);

CREATE INDEX IF NOT EXISTS review_schedule_history_group_id_idx
  ON public.review_schedule_history (review_group_id);

DROP POLICY IF EXISTS "rsh_select" ON public.review_schedule_history;
DROP POLICY IF EXISTS "rsh_insert" ON public.review_schedule_history;
DROP POLICY IF EXISTS "rsh_delete" ON public.review_schedule_history;

CREATE POLICY "rsh_select" ON public.review_schedule_history
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "rsh_insert" ON public.review_schedule_history
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "rsh_delete" ON public.review_schedule_history
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- =============================================================================
-- user_learning_settings
-- Dias da semana ativos para revisão: uma linha por usuário.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.user_learning_settings (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID         NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Array de dias ativos: 0=Dom, 1=Seg, 2=Ter, 3=Qua, 4=Qui, 5=Sex, 6=Sáb
  active_weekdays JSONB        NOT NULL DEFAULT '[1,2,3,4,5]'::jsonb,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE public.user_learning_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "uls_all" ON public.user_learning_settings;

CREATE POLICY "uls_all" ON public.user_learning_settings
  FOR ALL TO authenticated
  USING     (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- =============================================================================
-- learning_day_overrides
-- Exceções pontuais: dias normalmente inativos ativados manualmente.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.learning_day_overrides (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entry_date DATE         NOT NULL,
  is_active  BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, entry_date)
);

ALTER TABLE public.learning_day_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ldo_all" ON public.learning_day_overrides;

CREATE POLICY "ldo_all" ON public.learning_day_overrides
  FOR ALL TO authenticated
  USING     (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- =============================================================================
-- RPC: apply_review_schedule
-- Atualiza o agendamento de revisão de forma atômica e idempotente.
-- Versão final: migration_learning_settings (com ajuste de dias ativos).
-- SECURITY INVOKER: RLS aplica-se normalmente; auth.uid() está disponível.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.apply_review_schedule(p_attempt_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, auth
AS $$
DECLARE
  v_attempt        RECORD;
  v_group          RECORD;
  v_prev_level     INTEGER;
  v_prev_status    TEXT;
  v_prev_next      TIMESTAMPTZ;
  v_new_level      INTEGER;
  v_new_status     TEXT;
  v_new_next       TIMESTAMPTZ;
  v_interval_days  INTEGER;
  v_weekdays       INTEGER[];
  v_candidate      TIMESTAMPTZ;
  v_iter           INTEGER;
BEGIN
  SELECT * INTO v_attempt
  FROM public.review_attempts
  WHERE id = p_attempt_id AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tentativa não encontrada ou não autorizada';
  END IF;

  SELECT * INTO v_group
  FROM public.review_groups
  WHERE id = v_attempt.review_group_id AND user_id = auth.uid()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Grupo de revisão não encontrado ou não autorizado';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.review_schedule_history
    WHERE review_attempt_id = p_attempt_id
  ) THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'already_processed');
  END IF;

  IF v_group.status = 'mastered' OR v_group.review_level >= 4 THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'already_mastered');
  END IF;

  v_prev_level  := v_group.review_level;
  v_prev_status := v_group.status;
  v_prev_next   := v_group.next_review_at;

  SELECT ARRAY(SELECT jsonb_array_elements_text(active_weekdays)::INTEGER)
  INTO v_weekdays
  FROM public.user_learning_settings
  WHERE user_id = auth.uid();

  IF v_weekdays IS NULL OR array_length(v_weekdays, 1) = 0 THEN
    v_weekdays := ARRAY[1,2,3,4,5];
  END IF;

  IF v_attempt.overall_result = 'passed' THEN
    CASE v_group.review_level
      WHEN 0 THEN v_new_level := 1; v_interval_days := 7;
               v_new_next := (NOW() AT TIME ZONE 'utc') + INTERVAL '7 days';
               v_new_status := 'scheduled';
      WHEN 1 THEN v_new_level := 2; v_interval_days := 21;
               v_new_next := (NOW() AT TIME ZONE 'utc') + INTERVAL '21 days';
               v_new_status := 'scheduled';
      WHEN 2 THEN v_new_level := 3; v_interval_days := 60;
               v_new_next := (NOW() AT TIME ZONE 'utc') + INTERVAL '60 days';
               v_new_status := 'scheduled';
      WHEN 3 THEN v_new_level := 4; v_interval_days := NULL;
               v_new_next := NULL; v_new_status := 'mastered';
      ELSE RETURN jsonb_build_object('skipped', true, 'reason', 'already_mastered');
    END CASE;
  ELSE
    v_new_level := 0; v_interval_days := 2;
    v_new_next  := (NOW() AT TIME ZONE 'utc') + INTERVAL '2 days';
    v_new_status := 'scheduled';
  END IF;

  IF v_new_next IS NOT NULL THEN
    v_candidate := v_new_next;
    v_iter := 0;
    WHILE NOT (EXTRACT(DOW FROM v_candidate)::INTEGER = ANY(v_weekdays)) AND v_iter < 8 LOOP
      v_candidate := v_candidate + INTERVAL '1 day';
      v_iter := v_iter + 1;
    END LOOP;
    v_new_next := v_candidate;
  END IF;

  UPDATE public.review_groups
  SET review_level   = v_new_level,
      status         = v_new_status,
      next_review_at = v_new_next,
      updated_at     = NOW()
  WHERE id = v_group.id AND review_level = v_prev_level;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'concurrent_update');
  END IF;

  INSERT INTO public.review_schedule_history (
    user_id, review_group_id, review_attempt_id,
    previous_level, new_level, overall_result,
    previous_status, new_status,
    previous_next_review_at, new_next_review_at
  ) VALUES (
    auth.uid(), v_group.id, p_attempt_id,
    v_prev_level, v_new_level, v_attempt.overall_result,
    v_prev_status, v_new_status,
    v_prev_next, v_new_next
  );

  RETURN jsonb_build_object(
    'applied',       true,
    'newLevel',      v_new_level,
    'newStatus',     v_new_status,
    'nextReviewAt',  v_new_next,
    'intervalDays',  v_interval_days,
    'overallResult', v_attempt.overall_result
  );
END;
$$;

-- =============================================================================
-- FIM DO SCHEMA CANÔNICO
-- =============================================================================
