-- =============================================================================
-- MANUAL VALIDATION: AI Gateway enforcement — concurrency scenarios
-- Etapa 11, Fase 15.
--
-- WHY THIS FILE EXISTS: unit tests (api/__tests__/enforcement.test.ts,
-- ai-gateway-enforcement-wrappers.test.ts) mock every repository/RPC and
-- therefore cannot prove real Postgres-level atomicity — a mock always
-- "wins" the race because there is no race. No local Postgres instance is
-- available in this development environment (SUPABASE_SERVICE_ROLE_KEY is
-- not present in .env locally), so these scenarios were NOT executed as
-- part of this delivery. This file is the honest substitute Fase 15 asks
-- for: real, runnable SQL a human (or CI with a real Postgres/Supabase
-- branch) can execute to actually prove or disprove each atomicity claim,
-- rather than asserting it was validated when it wasn't.
--
-- HOW TO RUN: this migration (20260718000000_ai_gateway_enforcement.sql)
-- must be applied first, to a scratch/staging database — never production.
-- For each numbered scenario below, open TWO separate psql/SQL-editor
-- sessions (session A and session B) and follow the interleaving
-- instructions exactly; the whole point is that both sessions issue their
-- statement before either commits, which a single sequential script cannot
-- express on its own.
--
-- Replace the placeholder UUIDs below with real values before running
-- (a real auth.users id for USER, any of the 25 seeded ai_features rows for
-- FEATURE). None of these scenarios write to ai_usage_events or any other
-- table this migration doesn't own — safe to run repeatedly and to clean up
-- via the DELETE statements at the end of each section.
-- =============================================================================

-- Convenience placeholders — substitute real values.
-- \set test_user_id 'REPLACE-WITH-A-REAL-AUTH-USERS-ID'
-- \set test_feature  'writing.correct'

-- ─────────────────────────────────────────────────────────────────────────────
-- SCENARIO 1: check_and_increment_rate_limit — atomic under concurrency
-- ─────────────────────────────────────────────────────────────────────────────
-- Claim: two concurrent callers racing the same (user_id, route_key) can
-- never both be counted as request #1 — the INSERT ... ON CONFLICT DO
-- UPDATE ... RETURNING is a single atomic statement; Postgres serializes
-- the row lock on the conflicting key.
--
-- Setup: max_requests = 1, window_seconds = 60 — the second concurrent call
-- MUST be rejected regardless of arrival order.

-- Session A and Session B — paste into two separate connections, run within
-- the same second (interleave manually, or use \timing to confirm overlap):

-- SESSION A:
SELECT public.check_and_increment_rate_limit(
  '00000000-0000-0000-0000-000000000001'::uuid, 'preflight-validation:scenario1', 60, 1
);

-- SESSION B (run immediately, before reading A's result):
SELECT public.check_and_increment_rate_limit(
  '00000000-0000-0000-0000-000000000001'::uuid, 'preflight-validation:scenario1', 60, 1
);

-- EXPECTED: exactly one of A/B returns {"allowed": true}; the other returns
-- {"allowed": false, "retry_after": <n>}. If both return allowed:true, the
-- atomicity claim is FALSE and rate-limiter.ts must not be trusted as-is.

-- Cleanup:
DELETE FROM public.api_rate_limits WHERE route_key = 'preflight-validation:scenario1';

-- ─────────────────────────────────────────────────────────────────────────────
-- SCENARIO 2: begin_gateway_idempotent_op_v1 — atomic dedupe under concurrency
-- ─────────────────────────────────────────────────────────────────────────────
-- Claim: two concurrent callers racing the same (scope, idempotency_key)
-- can never both receive outcome='started' — exactly one does; the other
-- receives 'in_progress'.

-- SESSION A:
SELECT * FROM public.begin_gateway_idempotent_op_v1('preflight-validation:scenario2', 'idem-key-1', 30);

-- SESSION B (run immediately, before A completes/fails its lock):
SELECT * FROM public.begin_gateway_idempotent_op_v1('preflight-validation:scenario2', 'idem-key-1', 30);

-- EXPECTED: exactly one of A/B has outcome='started'; the other has
-- outcome='in_progress' with the SAME lock_id as the winner. If both show
-- 'started', the claim is FALSE.

-- Cleanup:
DELETE FROM public.ai_gateway_idempotency_locks WHERE scope = 'preflight-validation:scenario2';

-- Follow-up (single session, sequential — proves reclaim works):
SELECT * FROM public.fail_gateway_idempotent_op_v1(
  (SELECT id FROM public.ai_gateway_idempotency_locks WHERE scope = 'preflight-validation:scenario2' AND idempotency_key = 'idem-key-1')
);
SELECT * FROM public.begin_gateway_idempotent_op_v1('preflight-validation:scenario2', 'idem-key-1', 30);
-- EXPECTED: outcome='reclaimed' (the failed lock is reclaimable immediately, no wait needed).

DELETE FROM public.ai_gateway_idempotency_locks WHERE scope = 'preflight-validation:scenario2';

-- ─────────────────────────────────────────────────────────────────────────────
-- SCENARIO 3: reserve_gateway_usage_v1 — idempotency_key uniqueness under concurrency
-- ─────────────────────────────────────────────────────────────────────────────
-- Claim: two concurrent callers racing the same idempotency_key can never
-- both create a new usage_reservations row — the unique index on
-- idempotency_key plus the unique_violation EXCEPTION handler guarantees
-- exactly one row is ever created for that key, and the "loser" gets back
-- the winner's row rather than an error.
--
-- Replace FEATURE_KEY below with a real feature_key from ai_features.

-- SESSION A:
SELECT * FROM public.reserve_gateway_usage_v1(
  'preflight-validation-scenario3', NULL, NULL, 'writing.correct', 'openai', 'gpt-4o-mini',
  '[{"quota_key":"output_text_tokens","unit_type":"token","reserved_quantity":500}]'::jsonb,
  NULL, 120
);

-- SESSION B (run immediately):
SELECT * FROM public.reserve_gateway_usage_v1(
  'preflight-validation-scenario3', NULL, NULL, 'writing.correct', 'openai', 'gpt-4o-mini',
  '[{"quota_key":"output_text_tokens","unit_type":"token","reserved_quantity":500}]'::jsonb,
  NULL, 120
);

-- EXPECTED: both A and B return the SAME reservation_id. Verify only one
-- row and one set of items were created:
SELECT count(*) FROM public.usage_reservations WHERE idempotency_key = 'preflight-validation-scenario3';
-- EXPECTED: 1
SELECT count(*) FROM public.usage_reservation_items ri
  JOIN public.usage_reservations r ON r.id = ri.reservation_id
  WHERE r.idempotency_key = 'preflight-validation-scenario3';
-- EXPECTED: 1 (not 2 — a second concurrent INSERT into usage_reservation_items
-- never happens because the reservation INSERT itself failed with
-- unique_violation and returned early, before the items loop ran)

-- Cleanup:
DELETE FROM public.usage_reservation_items WHERE reservation_id IN (
  SELECT id FROM public.usage_reservations WHERE idempotency_key = 'preflight-validation-scenario3'
);
DELETE FROM public.usage_reservations WHERE idempotency_key = 'preflight-validation-scenario3';

-- ─────────────────────────────────────────────────────────────────────────────
-- SCENARIO 4 — NOT PROVEN SAFE (documented gap, not a passing test)
-- ─────────────────────────────────────────────────────────────────────────────
-- "Two simultaneous calls at the last dollar of budget — only one should be
-- allowed to reserve" (Fase 15's own required scenario). This is NOT
-- guaranteed by the current design: budgets.ts's SupabaseBudgetChecker.check()
-- and reserve_gateway_usage_v1 are two separate round trips (one SELECT
-- aggregate, one INSERT), not one atomic transaction. Run this to see the
-- failure mode directly:
--
-- Setup: an ai_runtime_controls row with daily_budget_usd = 1.00 for a
-- feature that has already spent 0.90 today (via usage_daily), and two
-- concurrent requests each estimating 0.08 (individually within budget:
-- 0.90 + 0.08 = 0.98 <= 1.00 — but together: 0.90 + 0.08 + 0.08 = 1.06 > 1.00).
--
-- SESSION A: SELECT check performed by budgets.ts equivalent —
SELECT calculated_cost_usd FROM public.usage_daily WHERE feature_key = 'writing.correct' AND usage_date = CURRENT_DATE;
-- (application code sums this + pending reservations + 0.08 and compares to 1.00 — both A and B do this BEFORE either reserves)

-- SESSION B: same read, same moment.

-- Both A and B then proceed to reserve_gateway_usage_v1 with
-- estimated_cost_usd = 0.08 each — both succeed, because the reservation
-- function has no awareness of the budget limit at all. Total reserved:
-- 0.16 against a 0.10 remaining budget. THE BUDGET IS OVERSUBSCRIBED.
--
-- CONCLUSION: this scenario is expected to FAIL today. Documented in
-- enforcement.ts's Fase-5-budget-check comment and in the Etapa 11 final
-- report as a known gap. Must be closed (fold the budget check into
-- reserve_gateway_usage_v1's own transaction, e.g. via a SELECT ... FOR
-- UPDATE on a per-scope budget-tracking row, or a single combined SQL
-- statement) before any budget-constrained feature is ever switched to
-- enforce. Rate limiting (Scenario 1), dedupe (Scenario 2), and reservation
-- row creation (Scenario 3) do NOT share this gap — each is independently
-- atomic as demonstrated above.

-- ─────────────────────────────────────────────────────────────────────────────
-- SCENARIO 5: record_gateway_breaker_outcome_v1 — half_open probe exclusivity
-- ─────────────────────────────────────────────────────────────────────────────
-- Claim: in half_open state with half_open_probe_count=1, only one
-- concurrent caller can ever receive probe_allowed=true from
-- get_gateway_breaker_state_v1 — the row lock (FOR UPDATE) inside the
-- function serializes concurrent readers.

-- Force the breaker open first (5 consecutive failures, default threshold):
SELECT public.record_gateway_breaker_outcome_v1('openai', 'gpt-4o-mini', 'preflight-validation-scenario5', false) FROM generate_series(1, 5);
-- Manually backdate opened_at so the cooldown has already elapsed (default 30s):
UPDATE public.ai_gateway_circuit_breakers
  SET opened_at = NOW() - INTERVAL '1 minute'
  WHERE provider = 'openai' AND model = 'gpt-4o-mini' AND feature_key = 'preflight-validation-scenario5';

-- SESSION A:
SELECT * FROM public.get_gateway_breaker_state_v1('openai', 'gpt-4o-mini', 'preflight-validation-scenario5');
-- SESSION B (run immediately after A transitions it to half_open):
SELECT * FROM public.get_gateway_breaker_state_v1('openai', 'gpt-4o-mini', 'preflight-validation-scenario5');

-- EXPECTED: exactly one of A/B has probe_allowed=true; the other (whichever
-- runs after the probe slot is claimed) has probe_allowed=false. If both
-- show true, the claim is FALSE.

-- Cleanup:
DELETE FROM public.ai_gateway_circuit_breakers WHERE feature_key = 'preflight-validation-scenario5';

-- =============================================================================
-- SUMMARY (fill in after actually running the above against a real Postgres)
-- =============================================================================
-- Scenario 1 (rate limit atomic):        NOT EXECUTED in this delivery — no local Postgres available.
-- Scenario 2 (dedupe atomic):            NOT EXECUTED in this delivery — no local Postgres available.
-- Scenario 3 (reservation idempotency):  NOT EXECUTED in this delivery — no local Postgres available.
-- Scenario 4 (budget last-dollar race):  KNOWN GAP, not expected to pass — see enforcement.ts's comment.
-- Scenario 5 (breaker probe exclusivity): NOT EXECUTED in this delivery — no local Postgres available.
--
-- All five scenarios' SQL was written and reasoned through against the
-- exact function bodies in 20260718000000_ai_gateway_enforcement.sql
-- (single-statement INSERT ... ON CONFLICT / unique-index-plus-exception /
-- SELECT ... FOR UPDATE patterns — each a well-established Postgres
-- atomicity idiom), but "reasoned through" is not the same as "proven by
-- execution." Re-run this file against a disposable Supabase branch or
-- local Postgres before ever enabling enforce for a real feature, and
-- update this summary with actual results.
-- =============================================================================
