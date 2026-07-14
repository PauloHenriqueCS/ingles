-- ai_conversation_preferences
-- Stores per-user AI tutor personality settings for the Conversa com IA feature.

CREATE TABLE IF NOT EXISTS ai_conversation_preferences (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  teacher_name     TEXT        NOT NULL DEFAULT 'Alex',
  personality      TEXT        NOT NULL DEFAULT 'friendly'
                               CHECK (personality IN ('friendly', 'professional', 'strict')),
  correction_style TEXT        NOT NULL DEFAULT 'gentle'
                               CHECK (correction_style IN ('gentle', 'direct')),
  voice            TEXT        NOT NULL DEFAULT 'marin',
  focus_areas      TEXT[]      NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_ai_prefs_per_user UNIQUE (user_id)
);

ALTER TABLE ai_conversation_preferences ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'ai_conversation_preferences'
      AND policyname = 'Users manage own AI preferences'
  ) THEN
    CREATE POLICY "Users manage own AI preferences"
      ON ai_conversation_preferences
      FOR ALL
      USING     (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

-- Auto-set user_id on INSERT from auth context
CREATE OR REPLACE FUNCTION set_ai_prefs_user_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.user_id  := COALESCE(NEW.user_id, auth.uid());
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ai_prefs_user_id ON ai_conversation_preferences;
CREATE TRIGGER trg_ai_prefs_user_id
  BEFORE INSERT OR UPDATE ON ai_conversation_preferences
  FOR EACH ROW EXECUTE FUNCTION set_ai_prefs_user_id();
