-- =============================================================================
-- Conversation session duration: server-authoritative, closes a quota bypass
-- =============================================================================
-- Found during the plan/limits audit (2026-07-21):
--
--   conversation_sessions had RLS policy "Users manage own conversation
--   sessions" FOR ALL USING/WITH CHECK (auth.uid() = user_id) — an
--   authenticated student could INSERT that table directly from the browser
--   (e.g. supabase.from('conversation_sessions').insert({...})) with ANY
--   duration_sec they chose. api/_entitlements/plan-entitlements-service.ts
--   sums duration_sec from this exact table to decide whether a NEW paid
--   OpenAI Realtime conversation session may start
--   (entitlements.conversation.monthlyTime.canStart). Reporting a low/zero
--   duration after each real (costly) conversation — or simply never
--   reporting one at all — kept consumed usage at ~0 forever, giving
--   unlimited real-time AI conversation regardless of plan limits.
--
--   This is the same class of bug as pronunciation_assessments, which
--   already blocks direct client INSERT/UPDATE and requires a
--   SECURITY DEFINER RPC — conversation_sessions was the outlier that never
--   got the same treatment.
--
-- Fix:
--   1. conversation_session_authorizations — a new, backend-only ledger.
--      /api/conversation/session (api/conversation/[...slug].ts) writes one
--      row per issued realtime token via the service-role client, before any
--      client code runs. A new /api/conversation/session-complete endpoint
--      closes it, computing duration_seconds itself from
--      now() - authorized_at (clamped to authorized_max_seconds) — never
--      from a client-supplied number. Deliberately independent of the AI
--      Gateway's ai_provider_sessions (observe-mode only; conversation.
--      webrtc_connect is still seeded 'legacy' — see
--      20260717000000_create_ai_gateway_foundation.sql — a separate, still
--      -staged rollout this migration does not touch), so commercial quota
--      enforcement never depends on that unrelated flag.
--   2. conversation_sessions keeps its existing shape (still read by
--      getDayTotalSeconds/getMonthSessionTotals for the calendar and daily
--      goal UI) but loses direct client write access: only SELECT remains
--      for the owning user. The session-complete handler mirrors the
--      authoritative duration into it server-side.
--
-- Idempotent: safe to re-run.
-- Rollback: re-create the old FOR ALL policy on conversation_sessions and
-- drop conversation_session_authorizations; no destructive data changes are
-- made by this migration (existing conversation_sessions rows are untouched).
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 1: conversation_session_authorizations
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.conversation_session_authorizations (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_date           DATE        NOT NULL,
  authorized_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  authorized_max_seconds INTEGER     NOT NULL CHECK (authorized_max_seconds > 0),
  status                 TEXT        NOT NULL DEFAULT 'authorized',
  completed_at           TIMESTAMPTZ,
  duration_seconds       INTEGER,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_csa_status CHECK (status IN ('authorized', 'completed')),
  CONSTRAINT chk_csa_duration_non_negative CHECK (duration_seconds IS NULL OR duration_seconds >= 0)
);

ALTER TABLE public.conversation_session_authorizations ENABLE ROW LEVEL SECURITY;
-- No policies granted to authenticated/anon — this table is written and read
-- exclusively by the backend's service-role client (which bypasses RLS),
-- same posture as ai_provider_sessions. The frontend never queries it.

CREATE INDEX IF NOT EXISTS idx_csa_user_month
  ON public.conversation_session_authorizations (user_id, session_date);

-- Speeds up any future sweep of long-abandoned 'authorized' rows.
CREATE INDEX IF NOT EXISTS idx_csa_stale_authorized
  ON public.conversation_session_authorizations (authorized_at)
  WHERE status = 'authorized';

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 2: lock down conversation_sessions to SELECT-only for the owner
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'conversation_sessions'
  ) THEN
    EXECUTE 'DROP POLICY IF EXISTS "Users manage own conversation sessions" ON public.conversation_sessions';

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename  = 'conversation_sessions'
        AND policyname = 'Users view own conversation sessions'
    ) THEN
      EXECUTE 'CREATE POLICY "Users view own conversation sessions" ON public.conversation_sessions FOR SELECT USING (auth.uid() = user_id)';
    END IF;
  END IF;
END $$;

COMMIT;
