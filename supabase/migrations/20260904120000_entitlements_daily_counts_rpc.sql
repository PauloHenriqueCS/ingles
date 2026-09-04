-- =============================================================================
-- Entitlements daily-usage counts — single-round-trip RPC
-- -----------------------------------------------------------------------------
-- api/_entitlements/plan-entitlements-service.ts resolves a user's snapshot on
-- NEARLY EVERY /api route. Its per-call cost was a Promise.all of NINE separate
-- PostgREST queries, five of which are daily-usage count(*) scans. On the
-- CPU-bound (Micro) Postgres instance, N users hitting Home at once fan that out
-- to ~9*N concurrent queries and starve CPU — exactly the burst that tripped the
-- production db_latency degradation alert (p95 1686ms, resolve_entitlements peak
-- 3471ms). See 20260831130000_observability_degradation_alerts.sql.
--
-- This collapses those FIVE count(*) scans into ONE round-trip. The day
-- boundaries are computed by the caller (TS) and passed in as parameters, so the
-- SQL never re-derives a timezone and can never disagree with the TS semantics
-- it replaces — it is a 1:1 translation of the five .from(...).select(count) calls:
--   * theme_count                  generated_themes            (UTC day, created_at)
--   * review_count                 writing_review_reservations (UTC day, created_at, status in reserved/completed)
--   * pronunciation_eval_count     pronunciation_assessments   (UTC day, completed_at, status=completed)
--   * listening_count              user_listening_shared_progress completed=true
--                                    JOIN listening_shared_stories on the São Paulo practice_date
--   * pronunciation_training_count pronunciation_training_sessions (SP practice_date, status=completed)
--
-- The other four members of the Promise.all (plan_capability_values,
-- user_capability_overrides, user_conversation_credits, and the conversation
-- authorizations rows used for the live-elapsed reduction) stay as-is — they
-- return rows the resolver post-processes in TS, not simple scalars.
--
-- STABLE + SECURITY DEFINER: the resolver already runs with the shared
-- service-role client; keeping this DEFINER + service_role-only matches the
-- project's other backend RPCs and the tables' service_role-only access. Reads
-- only counts (no PII / content ever returned).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.resolve_daily_activity_counts_v1(
  p_user_id       uuid,
  p_utc_day_start timestamptz,
  p_utc_day_end   timestamptz,
  p_sp_date       date
) RETURNS TABLE (
  theme_count                  integer,
  review_count                 integer,
  pronunciation_eval_count     integer,
  listening_count              integer,
  pronunciation_training_count integer
)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public'
AS $fn$
  SELECT
    -- Writing theme generations used today (UTC day), by created_at.
    (SELECT count(*)
       FROM public.generated_themes gt
      WHERE gt.user_id = p_user_id
        AND gt.created_at >= p_utc_day_start
        AND gt.created_at <  p_utc_day_end)::int,
    -- Writing reviews used today: the reserve/complete ledger, counted by
    -- created_at; 'reserved' holds a slot the instant it is taken.
    (SELECT count(*)
       FROM public.writing_review_reservations wrr
      WHERE wrr.user_id = p_user_id
        AND wrr.status IN ('reserved', 'completed')
        AND wrr.created_at >= p_utc_day_start
        AND wrr.created_at <  p_utc_day_end)::int,
    -- Diary pronunciation evaluations completed today (UTC day), by completed_at.
    (SELECT count(*)
       FROM public.pronunciation_assessments pa
      WHERE pa.user_id = p_user_id
        AND pa.status = 'completed'
        AND pa.completed_at >= p_utc_day_start
        AND pa.completed_at <  p_utc_day_end)::int,
    -- História: quota is consumed ONLY when a shared story is actually practiced
    -- (completed=true), scoped to TODAY's São Paulo practice_date via the FK.
    (SELECT count(*)
       FROM public.user_listening_shared_progress ulsp
       JOIN public.listening_shared_stories lss ON lss.id = ulsp.shared_story_id
      WHERE ulsp.user_id = p_user_id
        AND ulsp.completed = true
        AND lss.practice_date = p_sp_date)::int,
    -- Standalone "Treinar pronúncia" surface, by its own SP practice_date.
    (SELECT count(*)
       FROM public.pronunciation_training_sessions pts
      WHERE pts.user_id = p_user_id
        AND pts.status = 'completed'
        AND pts.practice_date = p_sp_date)::int;
$fn$;

REVOKE ALL ON FUNCTION public.resolve_daily_activity_counts_v1(uuid, timestamptz, timestamptz, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_daily_activity_counts_v1(uuid, timestamptz, timestamptz, date) TO service_role;
