-- Módulo de Listening: episódios diários com 2 blocos, 2 perguntas, legendas sincronizadas,
-- progresso por bloco e tentativas com controle de modo de legenda.
-- Acesso a perguntas restrito ao service role (correct_option nunca exposto ao frontend).

-- ─── Enums ────────────────────────────────────────────────────────────────────

CREATE TYPE listening_episode_status AS ENUM (
  'draft',
  'content_ready',
  'audio_processing',
  'ready',
  'published',
  'failed',
  'archived'
);

CREATE TYPE listening_block_status AS ENUM (
  'draft',
  'content_ready',
  'audio_processing',
  'ready',
  'failed'
);

CREATE TYPE listening_subtitle_language AS ENUM (
  'en',
  'pt-BR'
);

CREATE TYPE user_listening_progress_status AS ENUM (
  'not_started',
  'block_1_active',
  'block_1_completed',
  'block_2_active',
  'completed'
);

CREATE TYPE listening_subtitle_mode AS ENUM (
  'none',
  'en',
  'pt-BR'
);

-- ─── listening_episodes ───────────────────────────────────────────────────────

CREATE TABLE listening_episodes (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title                       TEXT NOT NULL,
  synopsis                    TEXT,
  cefr_level                  TEXT NOT NULL CHECK (cefr_level IN ('A1','A2','B1','B2','C1','C2')),
  status                      listening_episode_status NOT NULL DEFAULT 'draft',
  content_version             INTEGER NOT NULL DEFAULT 1 CHECK (content_version >= 1),
  estimated_duration_seconds  INTEGER CHECK (estimated_duration_seconds IS NULL OR estimated_duration_seconds > 0),
  actual_duration_seconds     INTEGER CHECK (actual_duration_seconds IS NULL OR actual_duration_seconds > 0),
  voice_name                  TEXT,
  published_at                TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_le_published_requires_date
    CHECK (status != 'published' OR published_at IS NOT NULL)
);

CREATE INDEX idx_le_status_level_published ON listening_episodes (status, cefr_level, published_at);

ALTER TABLE listening_episodes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read published episodes"
  ON listening_episodes FOR SELECT TO authenticated
  USING (status = 'published');

-- ─── listening_blocks ─────────────────────────────────────────────────────────

CREATE TABLE listening_blocks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id      UUID NOT NULL REFERENCES listening_episodes(id) ON DELETE CASCADE,
  block_order     INTEGER NOT NULL CHECK (block_order IN (1, 2)),
  text_en         TEXT NOT NULL,
  translation_pt  TEXT,
  ssml            TEXT,
  audio_path      TEXT,
  duration_ms     INTEGER CHECK (duration_ms IS NULL OR duration_ms > 0),
  status          listening_block_status NOT NULL DEFAULT 'draft',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (episode_id, block_order)
);

CREATE INDEX idx_lb_episode_order ON listening_blocks (episode_id, block_order);

ALTER TABLE listening_blocks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read blocks of published episodes"
  ON listening_blocks FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM listening_episodes e
      WHERE e.id = episode_id AND e.status = 'published'
    )
  );

-- ─── listening_subtitle_cues ──────────────────────────────────────────────────

CREATE TABLE listening_subtitle_cues (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  block_id      UUID NOT NULL REFERENCES listening_blocks(id) ON DELETE CASCADE,
  language      listening_subtitle_language NOT NULL,
  cue_order     INTEGER NOT NULL CHECK (cue_order >= 1),
  start_ms      INTEGER NOT NULL CHECK (start_ms >= 0),
  end_ms        INTEGER NOT NULL,
  text          TEXT NOT NULL,
  sentence_key  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (block_id, language, cue_order),
  CONSTRAINT chk_lsc_end_after_start CHECK (end_ms > start_ms)
);

CREATE INDEX idx_lsc_block_language_order ON listening_subtitle_cues (block_id, language, cue_order);

ALTER TABLE listening_subtitle_cues ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read cues of published blocks"
  ON listening_subtitle_cues FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM listening_blocks b
      JOIN listening_episodes e ON e.id = b.episode_id
      WHERE b.id = block_id AND e.status = 'published'
    )
  );

-- ─── listening_questions ──────────────────────────────────────────────────────
-- correct_option nunca é exposto ao frontend: tabela sem SELECT policy para usuários.
-- O backend lê via service role e retorna somente o tipo público (sem correct_option).
-- A view listening_questions_public abaixo é a alternativa segura para leitura direta.

CREATE TABLE listening_questions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id      UUID NOT NULL REFERENCES listening_episodes(id) ON DELETE CASCADE,
  block_id        UUID NOT NULL REFERENCES listening_blocks(id) ON DELETE CASCADE,
  question_order  INTEGER NOT NULL CHECK (question_order IN (1, 2)),
  prompt          TEXT NOT NULL,
  options_json    JSONB NOT NULL,
  correct_option  INTEGER NOT NULL CHECK (correct_option >= 0),
  explanation_pt  TEXT NOT NULL,
  max_attempts    INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts = 3),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (block_id),
  UNIQUE (episode_id, question_order),
  CONSTRAINT chk_lq_options_min_2
    CHECK (jsonb_typeof(options_json) = 'array' AND jsonb_array_length(options_json) >= 2),
  CONSTRAINT chk_lq_correct_in_range
    CHECK (correct_option < jsonb_array_length(options_json))
);

-- Trigger: bloco da pergunta deve pertencer ao mesmo episódio da pergunta.
-- Previne inconsistência como question.episode_id = A e question.block.episode_id = B.
CREATE OR REPLACE FUNCTION validate_listening_question_block_episode()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM listening_blocks b
    WHERE b.id = NEW.block_id AND b.episode_id = NEW.episode_id
  ) THEN
    RAISE EXCEPTION
      'listening_questions: block_id % does not belong to episode_id %',
      NEW.block_id, NEW.episode_id
      USING ERRCODE = 'P0002';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_lq_validate_block_episode
  BEFORE INSERT OR UPDATE ON listening_questions
  FOR EACH ROW
  EXECUTE FUNCTION validate_listening_question_block_episode();

CREATE INDEX idx_lq_episode_order ON listening_questions (episode_id, question_order);

ALTER TABLE listening_questions ENABLE ROW LEVEL SECURITY;
-- Nenhuma SELECT policy para authenticated: leitura somente via service role.

-- View pública sem a resposta correta. Filtrada para episódios publicados.
-- Roda com direitos do owner (postgres), portanto acessa listening_questions sem RLS.
CREATE VIEW listening_questions_public AS
  SELECT
    q.id,
    q.episode_id,
    q.block_id,
    q.question_order,
    q.prompt,
    q.options_json,
    q.explanation_pt,
    q.max_attempts
  FROM listening_questions q
  JOIN listening_episodes e ON e.id = q.episode_id
  WHERE e.status = 'published';

-- ─── user_listening_progress ──────────────────────────────────────────────────

CREATE TABLE user_listening_progress (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  episode_id              UUID NOT NULL REFERENCES listening_episodes(id) ON DELETE CASCADE,
  status                  user_listening_progress_status NOT NULL DEFAULT 'not_started',
  current_block           INTEGER NOT NULL DEFAULT 1 CHECK (current_block IN (1, 2)),
  block_1_completed_at    TIMESTAMPTZ,
  block_1_correct_attempt INTEGER CHECK (block_1_correct_attempt IN (1, 2, 3)),
  block_2_completed_at    TIMESTAMPTZ,
  block_2_correct_attempt INTEGER CHECK (block_2_correct_attempt IN (1, 2, 3)),
  completed_at            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, episode_id),
  -- status = 'completed' exige todos os campos obrigatórios preenchidos.
  CONSTRAINT chk_ulp_completed_requires_all_fields CHECK (
    status != 'completed' OR (
      block_1_completed_at  IS NOT NULL AND
      block_2_completed_at  IS NOT NULL AND
      block_1_correct_attempt IS NOT NULL AND
      block_2_correct_attempt IS NOT NULL AND
      completed_at          IS NOT NULL
    )
  ),
  -- completed_at só pode existir quando status = 'completed'.
  CONSTRAINT chk_ulp_completed_at_requires_completed_status CHECK (
    completed_at IS NULL OR status = 'completed'
  ),
  -- Bloco 2 não pode ser concluído sem o bloco 1.
  CONSTRAINT chk_ulp_block2_requires_block1 CHECK (
    block_2_completed_at IS NULL OR block_1_completed_at IS NOT NULL
  )
);

CREATE INDEX idx_ulp_user_status ON user_listening_progress (user_id, status);
-- idx_ulp_user_episode coberto pelo UNIQUE(user_id, episode_id).

ALTER TABLE user_listening_progress ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own listening progress"
  ON user_listening_progress FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- Inserções e atualizações somente via service role para garantir transações seguras.

-- ─── user_listening_attempts ──────────────────────────────────────────────────

CREATE TABLE user_listening_attempts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  episode_id      UUID NOT NULL REFERENCES listening_episodes(id) ON DELETE CASCADE,
  block_id        UUID NOT NULL REFERENCES listening_blocks(id) ON DELETE CASCADE,
  question_id     UUID NOT NULL REFERENCES listening_questions(id) ON DELETE CASCADE,
  attempt_cycle   INTEGER NOT NULL DEFAULT 1 CHECK (attempt_cycle >= 1),
  attempt_number  INTEGER NOT NULL CHECK (attempt_number IN (1, 2, 3)),
  selected_option INTEGER NOT NULL CHECK (selected_option >= 0),
  is_correct      BOOLEAN,
  subtitle_mode   listening_subtitle_mode NOT NULL,
  playback_rate   NUMERIC(4,2) NOT NULL DEFAULT 1.0 CHECK (playback_rate > 0),
  answered_at     TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, question_id, attempt_cycle, attempt_number),
  -- Tentativa 1 → none, tentativa 2 → en, tentativa 3 → pt-BR.
  CONSTRAINT chk_ula_subtitle_matches_attempt CHECK (
    (attempt_number = 1 AND subtitle_mode = 'none')  OR
    (attempt_number = 2 AND subtitle_mode = 'en')    OR
    (attempt_number = 3 AND subtitle_mode = 'pt-BR')
  )
);

CREATE INDEX idx_ula_user_episode ON user_listening_attempts (user_id, episode_id);
CREATE INDEX idx_ula_question_cycle_attempt ON user_listening_attempts (question_id, attempt_cycle, attempt_number);

ALTER TABLE user_listening_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own listening attempts"
  ON user_listening_attempts FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- is_correct definido somente pelo backend via service role.
-- Inserções diretas pelo frontend são bloqueadas pela ausência de INSERT policy.
