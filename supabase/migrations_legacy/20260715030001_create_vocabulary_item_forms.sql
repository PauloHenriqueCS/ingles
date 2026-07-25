-- Forms and aliases for vocabulary items: plural, conjugation, contraction, etc.

CREATE TABLE vocabulary_item_forms (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vocabulary_item_id  UUID NOT NULL REFERENCES vocabulary_items(id) ON DELETE CASCADE,
  form_value          TEXT NOT NULL,
  normalized_form     TEXT NOT NULL,
  form_type           TEXT NOT NULL CHECK (form_type IN (
                        'lemma', 'inflection', 'plural', 'conjugation',
                        'contraction', 'spelling_variant', 'accepted_variant', 'alias')),
  locale              TEXT NOT NULL DEFAULT 'en',
  is_primary          BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vocabulary_item_id, normalized_form)
);

CREATE INDEX idx_vocabulary_forms_item ON vocabulary_item_forms (vocabulary_item_id);
CREATE INDEX idx_vocabulary_forms_normalized ON vocabulary_item_forms (normalized_form, locale);

ALTER TABLE vocabulary_item_forms ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone reads vocabulary forms"
  ON vocabulary_item_forms FOR SELECT
  USING (true);
