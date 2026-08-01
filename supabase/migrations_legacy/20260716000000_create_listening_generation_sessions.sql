-- Listening sob demanda: sessão de geração e campo synopsis_pt no episódio.

-- Adicionar synopsis_pt à tabela listening_episodes
ALTER TABLE listening_episodes
  ADD COLUMN IF NOT EXISTS synopsis_pt TEXT;

-- ── user_listening_generation_sessions ───────────────────────────────────────
-- Máquina de estados para acompanhar geração sob demanda por usuário/dia.
-- Garante idempotência e permite retomada após falhas.

CREATE TABLE user_listening_generation_sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  user_level        TEXT CHECK (user_level IN ('A1','A2','B1','B2','C1','C2')),
  local_date        DATE NOT NULL,
  idempotency_key   TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN (
      'created','identifying_level',
      'generating_block_1','validating_block_1',
      'generating_block_2','validating_block_2',
      'generating_questions','preparing_description','preparing_subtitles',
      'generating_audio_block_1','generating_audio_block_2',
      'validating_duration','finalizing','ready','failed','cancelled'
    )),
  current_step      TEXT,
  progress_percent  INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  episode_id        UUID REFERENCES listening_episodes(id),
  error_code        TEXT,
  error_message     TEXT,
  retryable         BOOLEAN NOT NULL DEFAULT false,
  locked_at         TIMESTAMPTZ,
  lock_expires_at   TIMESTAMPTZ,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Uma sessão ativa por usuário por dia (cancelled e failed são ignorados)
CREATE UNIQUE INDEX idx_ulgs_user_date_active
  ON user_listening_generation_sessions (user_id, local_date)
  WHERE status NOT IN ('cancelled', 'failed');

CREATE INDEX idx_ulgs_user_date ON user_listening_generation_sessions (user_id, local_date DESC);

ALTER TABLE user_listening_generation_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own generation sessions"
  ON user_listening_generation_sessions FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
