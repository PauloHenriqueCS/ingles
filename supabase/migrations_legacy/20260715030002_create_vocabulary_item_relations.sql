-- Synonym and relation links between vocabulary items.

CREATE TABLE vocabulary_item_relations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_item_id  UUID NOT NULL REFERENCES vocabulary_items(id) ON DELETE CASCADE,
  target_item_id  UUID NOT NULL REFERENCES vocabulary_items(id) ON DELETE CASCADE,
  relation_type   TEXT NOT NULL CHECK (relation_type IN (
                    'synonym', 'near_synonym', 'antonym', 'related',
                    'preferred_alternative', 'contextual_equivalent')),
  context_hint    TEXT,  -- optional context where this relation applies
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_item_id, target_item_id, relation_type)
);

CREATE INDEX idx_vocab_relations_source ON vocabulary_item_relations (source_item_id, relation_type);

ALTER TABLE vocabulary_item_relations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone reads vocabulary relations"
  ON vocabulary_item_relations FOR SELECT
  USING (true);
