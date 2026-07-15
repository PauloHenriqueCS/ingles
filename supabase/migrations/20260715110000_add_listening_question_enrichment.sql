-- Etapa 3: adiciona campos pedagógicos às perguntas de listening e controle
-- de status de geração de perguntas aos episódios.
-- Esta migration é aditiva e não altera constraints existentes.

-- ─── listening_questions: campos de enriquecimento ───────────────────────────

ALTER TABLE listening_questions
  ADD COLUMN IF NOT EXISTS question_type TEXT
    CHECK (
      question_type IS NULL OR
      question_type IN ('main_idea','detail','cause','sequence','intention','simple_inference')
    ),
  ADD COLUMN IF NOT EXISTS difficulty TEXT
    CHECK (difficulty IS NULL OR difficulty IN ('easy','appropriate','hard')),
  ADD COLUMN IF NOT EXISTS evidence_sentence_keys JSONB
    CHECK (
      evidence_sentence_keys IS NULL OR (
        jsonb_typeof(evidence_sentence_keys) = 'array' AND
        jsonb_array_length(evidence_sentence_keys) >= 1
      )
    ),
  ADD COLUMN IF NOT EXISTS validation_status TEXT
    CHECK (validation_status IS NULL OR validation_status IN ('pending','valid','invalid','needs_review')),
  ADD COLUMN IF NOT EXISTS validation_notes JSONB,
  ADD COLUMN IF NOT EXISTS generator_prompt_version TEXT,
  ADD COLUMN IF NOT EXISTS validator_prompt_version TEXT;

-- Índice para consultas de idempotência: busca perguntas válidas da versão atual.
CREATE INDEX IF NOT EXISTS idx_lq_episode_validation
  ON listening_questions (episode_id, validation_status, generator_prompt_version)
  WHERE validation_status IS NOT NULL;

-- ─── listening_episodes: controle de geração de perguntas ────────────────────

ALTER TABLE listening_episodes
  ADD COLUMN IF NOT EXISTS questions_status TEXT
    CHECK (questions_status IS NULL OR questions_status IN ('pending','processing','ready','failed')),
  ADD COLUMN IF NOT EXISTS questions_generated_at TIMESTAMPTZ;

-- Índice para filtrar episódios prontos para geração de perguntas.
CREATE INDEX IF NOT EXISTS idx_le_questions_status
  ON listening_episodes (questions_status)
  WHERE questions_status IS NOT NULL;
