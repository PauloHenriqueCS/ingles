-- Sentenças individuais de cada bloco de listening para sincronização TTS.
-- Também adiciona generation_key a listening_episodes para idempotência de geração.

ALTER TABLE listening_episodes
  ADD COLUMN generation_key TEXT UNIQUE;

CREATE TABLE listening_sentences (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  block_id        UUID NOT NULL REFERENCES listening_blocks(id) ON DELETE CASCADE,
  sentence_key    TEXT NOT NULL,
  sentence_order  INTEGER NOT NULL CHECK (sentence_order >= 1),
  paragraph_order INTEGER NOT NULL CHECK (paragraph_order >= 1),
  speaker         TEXT,
  text_en         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (block_id, sentence_order),
  UNIQUE (block_id, sentence_key)
);

CREATE INDEX idx_ls_block_order ON listening_sentences (block_id, sentence_order);

ALTER TABLE listening_sentences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read sentences of published blocks"
  ON listening_sentences FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM listening_blocks b
      JOIN listening_episodes e ON e.id = b.episode_id
      WHERE b.id = block_id AND e.status = 'published'
    )
  );
