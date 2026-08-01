-- Enriquecimento da tabela listening_subtitle_cues para suportar
-- o pipeline de preparação de legendas (Etapa 4).
-- Torna start_ms/end_ms opcionais antes da síntese do áudio,
-- adiciona cue_key estável, source_sentence_keys, status e content_version.
-- Também adiciona campos de controle de legendas em listening_episodes.

-- ─── listening_subtitle_cues ──────────────────────────────────────────────────

-- 1. Tornar timestamps opcionais (preenchidos apenas após áudio)
ALTER TABLE listening_subtitle_cues
  ALTER COLUMN start_ms DROP NOT NULL,
  ALTER COLUMN end_ms   DROP NOT NULL;

-- 2. Remover constraint antiga (não permite nulos)
ALTER TABLE listening_subtitle_cues
  DROP CONSTRAINT IF EXISTS chk_lsc_end_after_start;

-- 3. Nova constraint: ambos nulos OU ambos preenchidos com valores válidos
ALTER TABLE listening_subtitle_cues
  ADD CONSTRAINT chk_lsc_timing CHECK (
    (start_ms IS NULL AND end_ms IS NULL)
    OR
    (start_ms IS NOT NULL AND end_ms IS NOT NULL AND start_ms >= 0 AND end_ms > start_ms)
  );

-- 4. Chave estável da cue (b1-c001, b2-c003, …)
ALTER TABLE listening_subtitle_cues
  ADD COLUMN IF NOT EXISTS cue_key TEXT;

ALTER TABLE listening_subtitle_cues
  ADD CONSTRAINT uq_lsc_block_lang_cue_key UNIQUE (block_id, language, cue_key);

-- 5. Array de sentence_keys de origem (substitui o campo singular sentence_key)
ALTER TABLE listening_subtitle_cues
  ADD COLUMN IF NOT EXISTS source_sentence_keys JSONB;

ALTER TABLE listening_subtitle_cues
  ADD CONSTRAINT chk_lsc_source_keys_array CHECK (
    source_sentence_keys IS NULL
    OR (jsonb_typeof(source_sentence_keys) = 'array'
        AND jsonb_array_length(source_sentence_keys) >= 1)
  );

-- 6. Status do ciclo de vida da cue
ALTER TABLE listening_subtitle_cues
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'timing_pending'
    CHECK (status IN ('text_ready', 'timing_pending', 'timed', 'failed'));

-- 7. Versão do conteúdo (sincroniza com content_version do episódio)
ALTER TABLE listening_subtitle_cues
  ADD COLUMN IF NOT EXISTS content_version INTEGER DEFAULT 1
    CHECK (content_version IS NULL OR content_version >= 1);

-- 8. updated_at para auditoria
ALTER TABLE listening_subtitle_cues
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- 9. Índice auxiliar por status
CREATE INDEX IF NOT EXISTS idx_lsc_block_lang_status
  ON listening_subtitle_cues (block_id, language, status);

-- ─── listening_episodes — campos de controle de legendas ─────────────────────

ALTER TABLE listening_episodes
  ADD COLUMN IF NOT EXISTS subtitles_status TEXT
    CHECK (subtitles_status IN ('pending', 'processing', 'ready', 'failed')),
  ADD COLUMN IF NOT EXISTS subtitles_generated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS subtitle_prompt_version TEXT,
  ADD COLUMN IF NOT EXISTS subtitle_validator_prompt_version TEXT;

CREATE INDEX IF NOT EXISTS idx_le_subtitles_status
  ON listening_episodes (subtitles_status);
