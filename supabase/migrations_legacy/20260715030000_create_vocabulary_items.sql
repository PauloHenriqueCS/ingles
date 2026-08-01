-- Canonical vocabulary item catalog.
-- Each row = one vocabulary item (word, phrasal verb, collocation, etc.)
-- Stable IDs; never use canonical_value as PK.

CREATE TABLE vocabulary_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_value     TEXT NOT NULL,
  normalized_value    TEXT NOT NULL,
  kind                TEXT NOT NULL DEFAULT 'word' CHECK (kind IN (
                        'word', 'phrasal_verb', 'collocation', 'fixed_expression',
                        'functional_phrase', 'connector', 'idiom')),
  language            TEXT NOT NULL DEFAULT 'en',
  translation_pt_br   TEXT,
  definition_en       TEXT,
  definition_pt_br    TEXT,
  cefr_minimum_level  TEXT CHECK (cefr_minimum_level IN ('A1','A2','B1','B2','C1','C2')),
  part_of_speech      TEXT,
  lemma               TEXT,
  is_multiword        BOOLEAN NOT NULL DEFAULT false,
  metadata_json       JSONB,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (normalized_value, language)
);

CREATE INDEX idx_vocabulary_items_normalized ON vocabulary_items (normalized_value, language);
CREATE INDEX idx_vocabulary_items_kind ON vocabulary_items (kind) WHERE is_active = true;

-- Vocabulary items are public catalog — users may read all active items
ALTER TABLE vocabulary_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone reads active vocabulary items"
  ON vocabulary_items FOR SELECT
  USING (is_active = true);
-- Writes via service role only
