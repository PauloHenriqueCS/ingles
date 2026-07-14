-- Adds daily conversation goal to user preferences and creates session tracking table.

-- ── 1. Add goal column to ai_conversation_preferences ────────────────────────

ALTER TABLE ai_conversation_preferences
  ADD COLUMN IF NOT EXISTS daily_conversation_goal_minutes INTEGER NOT NULL DEFAULT 15
    CHECK (daily_conversation_goal_minutes IN (5, 10, 15, 20, 30));

-- ── 2. Create conversation_sessions table ────────────────────────────────────

CREATE TABLE IF NOT EXISTS conversation_sessions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_date  DATE        NOT NULL,
  duration_sec  INTEGER     NOT NULL CHECK (duration_sec > 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE conversation_sessions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'conversation_sessions'
      AND policyname = 'Users manage own conversation sessions'
  ) THEN
    CREATE POLICY "Users manage own conversation sessions"
      ON conversation_sessions
      FOR ALL
      USING     (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION set_conversation_session_user_id()
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

DROP TRIGGER IF EXISTS trg_conv_session_user_id ON conversation_sessions;
CREATE TRIGGER trg_conv_session_user_id
  BEFORE INSERT ON conversation_sessions
  FOR EACH ROW EXECUTE FUNCTION set_conversation_session_user_id();

-- ── 3. Índice composto para getDayTotalSeconds ────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_conversation_sessions_user_date
  ON public.conversation_sessions (user_id, session_date);
