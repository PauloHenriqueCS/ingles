-- Pronunciation assessments table
-- Stores Azure Cognitive Services pronunciation evaluation results.
-- INSERT/UPDATE are blocked at the RLS level — only server-side code (via service_role or SECURITY DEFINER RPC) can write rows.
-- UNIQUE (user_id, text_version_id) prevents duplicate assessments for the same text version.

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS pronunciation_assessments (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  text_version_id         UUID NOT NULL REFERENCES english_reviews(id) ON DELETE CASCADE,

  status                  TEXT NOT NULL DEFAULT 'processing'
                            CHECK (status IN ('processing', 'completed', 'failed_retryable', 'failed_final')),

  reference_text          TEXT NOT NULL,
  language_code           TEXT NOT NULL DEFAULT 'en-US',
  azure_region            TEXT NOT NULL,

  -- Overall scores (0–100, NULL while processing or on failure)
  pronunciation_score     NUMERIC(5,2),
  accuracy_score          NUMERIC(5,2),
  fluency_score           NUMERIC(5,2),
  completeness_score      NUMERIC(5,2),
  prosody_score           NUMERIC(5,2),

  recognized_text         TEXT,
  words_json              JSONB,
  raw_result_json         JSONB,

  audio_path              TEXT,
  audio_duration_seconds  NUMERIC(8,3),

  error_code              TEXT,
  error_message           TEXT,

  started_at              TIMESTAMPTZ,
  completed_at            TIMESTAMPTZ,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_pronunciation_per_text_version UNIQUE (user_id, text_version_id)
);

CREATE INDEX IF NOT EXISTS idx_pronunciation_assessments_user
  ON pronunciation_assessments (user_id);

CREATE INDEX IF NOT EXISTS idx_pronunciation_assessments_text_version
  ON pronunciation_assessments (text_version_id);

DROP TRIGGER IF EXISTS pa_set_updated_at ON pronunciation_assessments;
CREATE TRIGGER pa_set_updated_at
  BEFORE UPDATE ON pronunciation_assessments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RLS
ALTER TABLE pronunciation_assessments ENABLE ROW LEVEL SECURITY;

-- Users can only read their own assessments; no direct INSERT/UPDATE from browser
DROP POLICY IF EXISTS pa_select ON pronunciation_assessments;
CREATE POLICY pa_select ON pronunciation_assessments
  FOR SELECT USING (auth.uid() = user_id);
