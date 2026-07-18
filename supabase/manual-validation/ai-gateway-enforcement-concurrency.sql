-- =============================================================================
-- MANUAL VALIDATION: AI Gateway enforcement — concurrency scenarios
-- Etapa 11 (Fase 15), corrected twice: first for the atomic budget+quota
-- redesign, now for real FK-safety and full runnability.
--
-- WHY THIS FILE EXISTS: unit tests (api/__tests__/enforcement.test.ts,
-- ai-gateway-enforcement-wrappers.test.ts) mock every repository/RPC and
-- therefore cannot prove real Postgres-level atomicity — a mock always
-- "wins" the race because there is no race. No local Postgres instance is
-- available in this development environment (SUPABASE_SERVICE_ROLE_KEY is
-- not present in .env locally), so NONE of these scenarios have been
-- executed as part of this delivery. Concurrency is NOT validated — do not
-- treat anything below as proven until it has actually been run.
--
-- ⚠️ RUN ONLY ON A SCRATCH/STAGING DATABASE. NEVER ON PRODUCTION.
-- Apply supabase/migrations/20260718000000_ai_gateway_enforcement.sql there
-- first (this file assumes it is already applied). Every scenario below is
-- isolated by construction (see "Isolation" notes per scenario) and cleans
-- up everything it creates — but a scratch database removes any remaining
-- risk if a cleanup step is skipped or a scenario is interrupted.
--
-- SETUP — read before running anything:
--   1. Some scenarios (4, 5, 7) create rows in tables with a real foreign
--      key to auth.users (usage_reservations.user_id,
--      ai_gateway_quota_buckets.subject_id) — Postgres will reject a
--      fabricated UUID that isn't a real row in auth.users, so this file
--      cannot invent one. Create ONE disposable test user in your
--      scratch/staging project first (Supabase Studio → Authentication →
--      Add user, or `supabase auth admin create-user` in the CLI), then set
--      it below:
CREATE TEMP TABLE _mv_config (test_user_id UUID);
INSERT INTO _mv_config VALUES ('00000000-0000-0000-0000-000000000000'); -- ← REPLACE with your real disposable test user's id
--   Every scenario reads it back via `(SELECT test_user_id FROM _mv_config)`
--   — edit the one INSERT above, nothing else.
--
--   2. Scenarios that need a `feature_key` use REAL, already-seeded feature
--      keys (usage_reservations.feature_key and
--      ai_gateway_circuit_breakers.feature_key both have a NOT NULL foreign
--      key to ai_features — a fabricated key would be rejected). To keep
--      these scenarios from ever touching real production breaker/quota
--      state for that feature, every synthetic row additionally uses an
--      obviously-fake MODEL string (e.g. 'preflight-validation-model') or a
--      synthetic idempotency_key/period — real traffic never uses these
--      values, so no synthetic row can ever collide with a real one, and
--      the cleanup at the end of each scenario removes exactly what that
--      scenario created (scoped by those same synthetic markers), never a
--      broader match.
--
--   3. No scenario here ever touches ai_usage_events, ai_usage_event_metrics,
--      or any pedagogical/domain table (writing entries, listening episodes,
--      conversation sessions, etc.) — only the Etapa 11 tables themselves
--      (ai_gateway_quota_buckets, ai_gateway_budget_buckets,
--      usage_reservations/usage_reservation_items,
--      ai_gateway_idempotency_locks, api_rate_limits,
--      ai_gateway_circuit_breakers) plus one disposable auth.users row you
--      create and own. Real consumption/usage history is never read,
--      written, or altered by anything below.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- SCENARIO 1: check_and_increment_rate_limit — atomic under concurrency
-- ─────────────────────────────────────────────────────────────────────────────
-- Claim: two concurrent callers racing the same (user_id, route_key) can
-- never both be counted as request #1 — the INSERT ... ON CONFLICT DO
-- UPDATE ... RETURNING is a single atomic statement; Postgres serializes
-- the row lock on the conflicting key.
--
-- Isolation: route_key is a synthetic literal no real code ever sends
-- ("gateway:<featureKey>" is the only prefix real code uses — see
-- rate-limiter.ts — this key deliberately does not match that shape).
--
-- Setup: max_requests = 1, window_seconds = 60 — the second concurrent call
-- MUST be rejected regardless of arrival order.

-- SESSION A:
SELECT public.check_and_increment_rate_limit(
  (SELECT test_user_id FROM _mv_config), 'manual-validation:scenario1', 60, 1
);

-- SESSION B (run immediately, before reading A's result):
SELECT public.check_and_increment_rate_limit(
  (SELECT test_user_id FROM _mv_config), 'manual-validation:scenario1', 60, 1
);

-- EXPECTED: exactly one of A/B returns {"allowed": true}; the other returns
-- {"allowed": false, "retry_after": <n>}. If both return allowed:true, the
-- atomicity claim is FALSE and rate-limiter.ts must not be trusted as-is.

-- Cleanup:
DELETE FROM public.api_rate_limits WHERE route_key = 'manual-validation:scenario1';

-- ─────────────────────────────────────────────────────────────────────────────
-- SCENARIO 2: begin_gateway_idempotent_op_v1 — atomic dedupe under concurrency
-- ─────────────────────────────────────────────────────────────────────────────
-- Claim: two concurrent callers racing the same (scope, idempotency_key)
-- can never both receive outcome='started' — exactly one does; the other
-- receives 'in_progress'.
--
-- Isolation: scope has no foreign key (plain TEXT) — the synthetic literal
-- below never collides with a real scope (real scopes are always a real
-- featureKey, e.g. 'writing.correct').

-- SESSION A:
SELECT * FROM public.begin_gateway_idempotent_op_v1('manual-validation:scenario2', 'idem-key-1', 30);

-- SESSION B (run immediately, before A completes/fails its lock):
SELECT * FROM public.begin_gateway_idempotent_op_v1('manual-validation:scenario2', 'idem-key-1', 30);

-- EXPECTED: exactly one of A/B has outcome='started'; the other has
-- outcome='in_progress' with the SAME lock_id as the winner. If both show
-- 'started', the claim is FALSE.

-- Cleanup:
DELETE FROM public.ai_gateway_idempotency_locks WHERE scope = 'manual-validation:scenario2';

-- Follow-up (single session, sequential — proves reclaim works):
SELECT * FROM public.fail_gateway_idempotent_op_v1(
  (SELECT id FROM public.ai_gateway_idempotency_locks WHERE scope = 'manual-validation:scenario2' AND idempotency_key = 'idem-key-1')
);
SELECT * FROM public.begin_gateway_idempotent_op_v1('manual-validation:scenario2', 'idem-key-1', 30);
-- EXPECTED: outcome='reclaimed' (the failed lock is reclaimable immediately, no wait needed).

DELETE FROM public.ai_gateway_idempotency_locks WHERE scope = 'manual-validation:scenario2';

-- ─────────────────────────────────────────────────────────────────────────────
-- SCENARIO 3: reserve_gateway_usage_v1 — idempotency_key uniqueness under concurrency
-- ─────────────────────────────────────────────────────────────────────────────
-- Claim: two concurrent callers racing the same idempotency_key can never
-- both create a new usage_reservations row — the unique index on
-- idempotency_key plus the unique_violation EXCEPTION handler guarantees
-- exactly one row is ever created for that key, and the "loser" gets back
-- the winner's row rather than an error.
--
-- Isolation: idempotency_key is a synthetic literal ('manual-validation-...')
-- no real client ever generates; feature_key must be real (FK) but no
-- quota/budget limit is passed (both null), so this reservation never
-- touches a shared quota/budget bucket — it only ever creates its own,
-- uniquely-keyed usage_reservations/usage_reservation_items rows.

-- SESSION A:
SELECT * FROM public.reserve_gateway_usage_v1(
  'manual-validation-scenario3', NULL, NULL, 'writing.correct', 'openai', 'gpt-4o-mini',
  '[{"quota_key":"output_text_tokens","unit_type":"token","reserved_quantity":500,"limit_quantity":null,"period_type":null,"period_start":null,"period_end":null}]'::jsonb,
  '[]'::jsonb, NULL, 120
);

-- SESSION B (run immediately):
SELECT * FROM public.reserve_gateway_usage_v1(
  'manual-validation-scenario3', NULL, NULL, 'writing.correct', 'openai', 'gpt-4o-mini',
  '[{"quota_key":"output_text_tokens","unit_type":"token","reserved_quantity":500,"limit_quantity":null,"period_type":null,"period_start":null,"period_end":null}]'::jsonb,
  '[]'::jsonb, NULL, 120
);

-- EXPECTED: both A and B return the SAME reservation_id. Verify only one
-- row and one set of items were created:
SELECT count(*) FROM public.usage_reservations WHERE idempotency_key = 'manual-validation-scenario3';
-- EXPECTED: 1
SELECT count(*) FROM public.usage_reservation_items ri
  JOIN public.usage_reservations r ON r.id = ri.reservation_id
  WHERE r.idempotency_key = 'manual-validation-scenario3';
-- EXPECTED: 1 (not 2 — a second concurrent INSERT into usage_reservation_items
-- never happens because the reservation INSERT itself failed with
-- unique_violation and returned early, before the items loop ran)

-- Cleanup:
DELETE FROM public.usage_reservation_items WHERE reservation_id IN (
  SELECT id FROM public.usage_reservations WHERE idempotency_key = 'manual-validation-scenario3'
);
DELETE FROM public.usage_reservations WHERE idempotency_key = 'manual-validation-scenario3';

-- ─────────────────────────────────────────────────────────────────────────────
-- SCENARIO 4: mandatory acceptance test — 600 session_seconds/month quota
-- ─────────────────────────────────────────────────────────────────────────────
-- Etapa 11's own required acceptance case. Proves quota is accumulated
-- (committed + reserved vs. limit), not just a per-call ceiling, and that
-- two concurrent calls near the remaining balance cannot both win.
--
-- Isolation: subject_id is your disposable test user (see SETUP) — the
-- bucket this creates is keyed to (that user, conversation.realtime_usage,
-- session_seconds, month, this exact period_start), so it can never be the
-- same row as a real user's real monthly bucket. period_start is also
-- deliberately set to a date far outside any real billing period
-- (year 2099) so it can never overlap even hypothetically.
--
-- Setup: a bucket already at committed=300, reserved=250 (out of a 600
-- limit — 50 remaining) is seeded directly (simulating prior real usage +
-- an existing in-flight reservation), then two concurrent 40-second
-- attempts race the remaining 50.

INSERT INTO public.ai_gateway_quota_buckets (
  subject_type, subject_id, feature_key, metric_key, period_type, period_start, period_end,
  committed_quantity, reserved_quantity
) VALUES (
  'user', (SELECT test_user_id FROM _mv_config), 'conversation.realtime_usage', 'session_seconds', 'month',
  '2099-01-01T00:00:00Z', '2099-02-01T00:00:00Z', 300, 250
);

-- SESSION A:
SELECT * FROM public.reserve_gateway_usage_v1(
  'manual-validation-scenario4-a', (SELECT test_user_id FROM _mv_config), NULL,
  'conversation.realtime_usage', 'openai', 'preflight-validation-model',
  '[{"quota_key":"session_seconds","unit_type":"second","reserved_quantity":40,"limit_quantity":600,"period_type":"month","period_start":"2099-01-01T00:00:00Z","period_end":"2099-02-01T00:00:00Z"}]'::jsonb,
  '[]'::jsonb, NULL, 120
);

-- SESSION B (run immediately, before A's transaction commits):
SELECT * FROM public.reserve_gateway_usage_v1(
  'manual-validation-scenario4-b', (SELECT test_user_id FROM _mv_config), NULL,
  'conversation.realtime_usage', 'openai', 'preflight-validation-model',
  '[{"quota_key":"session_seconds","unit_type":"second","reserved_quantity":40,"limit_quantity":600,"period_type":"month","period_start":"2099-01-01T00:00:00Z","period_end":"2099-02-01T00:00:00Z"}]'::jsonb,
  '[]'::jsonb, NULL, 120
);

-- EXPECTED: exactly one of A/B has status='pending' (a real reservation_id);
-- the other has status='blocked', blocked_reason='QUOTA_EXCEEDED',
-- blocked_detail='session_seconds' — because 250 (already reserved) + 40
-- (the winner's new reservation) = 290, leaving only 10 of the original 50
-- remaining, and 40 > 10 for the loser. If both show status='pending', the
-- claim is FALSE and the row-lock ordering in reserve_gateway_usage_v1 must
-- be re-examined.

SELECT reserved_quantity, committed_quantity FROM public.ai_gateway_quota_buckets
  WHERE subject_id = (SELECT test_user_id FROM _mv_config) AND metric_key = 'session_seconds' AND period_start = '2099-01-01T00:00:00Z';
-- EXPECTED: reserved_quantity = 290 (250 + exactly one winning 40), never 330.

-- Finalize the winning reservation with real usage of 20 (less than the 40
-- reserved) — proves the 20-second difference is returned to the bucket.
-- Replace <winning_reservation_id> with the reservation_id A or B actually
-- returned with status='pending':
--
-- SELECT public.commit_gateway_reservation_v1(
--   '<winning_reservation_id>'::uuid, gen_random_uuid(), NULL,
--   '[{"quota_key":"session_seconds","actual_quantity":20}]'::jsonb
-- );
-- SELECT reserved_quantity, committed_quantity FROM public.ai_gateway_quota_buckets
--   WHERE subject_id = (SELECT test_user_id FROM _mv_config) AND metric_key = 'session_seconds' AND period_start = '2099-01-01T00:00:00Z';
-- EXPECTED: reserved_quantity back down to 250 (290 - 40 released), committed_quantity = 320 (300 + 20 real).

-- Cleanup:
DELETE FROM public.usage_reservation_items WHERE reservation_id IN (
  SELECT id FROM public.usage_reservations WHERE idempotency_key LIKE 'manual-validation-scenario4-%'
);
DELETE FROM public.usage_reservations WHERE idempotency_key LIKE 'manual-validation-scenario4-%';
DELETE FROM public.ai_gateway_quota_buckets
  WHERE subject_id = (SELECT test_user_id FROM _mv_config) AND period_start = '2099-01-01T00:00:00Z';

-- ─────────────────────────────────────────────────────────────────────────────
-- SCENARIO 5: budget last-dollar race — CLOSED by the Etapa 11 correction
-- ─────────────────────────────────────────────────────────────────────────────
-- The first version of this delivery admitted this as a known, unfixed gap
-- (budget check and reserve were two separate round trips). The correction
-- folds budget validation into the SAME atomic reserve_gateway_usage_v1
-- transaction as quota, under the same deterministic lock ordering — this
-- scenario proves it.
--
-- Isolation: scope_key uses a synthetic feature-scope marker
-- ('manual-validation-scenario5') for the BUDGET bucket (ai_gateway_
-- budget_buckets.scope_key has no foreign key — it is validated
-- structurally by reserve_gateway_usage_v1, not by a DB constraint), so
-- this never touches a real feature's real budget bucket. The
-- reservation's own feature_key is still a real one (FK requirement) but
-- carries no quota limit, so it never touches any quota bucket either.
--
-- Setup: a budget bucket already at committed=0.90, reserved=0.00 against a
-- $1.00 daily limit ($0.10 remaining). Two concurrent calls each estimate
-- $0.08 — individually within budget (0.90+0.08=0.98<=1.00) but not
-- together (0.90+0.08+0.08=1.06>1.00).

INSERT INTO public.ai_gateway_budget_buckets (scope_type, scope_key, period_type, period_start, period_end, committed_cost_usd, reserved_cost_usd)
VALUES ('feature', 'manual-validation-scenario5', 'day', '2099-01-01T00:00:00Z', '2099-01-02T00:00:00Z', 0.90, 0.00);

-- SESSION A:
SELECT * FROM public.reserve_gateway_usage_v1(
  'manual-validation-scenario5-a', NULL, NULL, 'writing.correct', 'openai', 'preflight-validation-model',
  '[{"quota_key":"provider_requests","unit_type":"request","reserved_quantity":1,"limit_quantity":null,"period_type":null,"period_start":null,"period_end":null}]'::jsonb,
  '[{"scope_type":"feature","scope_key":"manual-validation-scenario5","period_type":"day","period_start":"2099-01-01T00:00:00Z","period_end":"2099-01-02T00:00:00Z","limit_usd":"1.00"}]'::jsonb,
  '0.08', 120
);

-- SESSION B (run immediately):
SELECT * FROM public.reserve_gateway_usage_v1(
  'manual-validation-scenario5-b', NULL, NULL, 'writing.correct', 'openai', 'preflight-validation-model',
  '[{"quota_key":"provider_requests","unit_type":"request","reserved_quantity":1,"limit_quantity":null,"period_type":null,"period_start":null,"period_end":null}]'::jsonb,
  '[{"scope_type":"feature","scope_key":"manual-validation-scenario5","period_type":"day","period_start":"2099-01-01T00:00:00Z","period_end":"2099-01-02T00:00:00Z","limit_usd":"1.00"}]'::jsonb,
  '0.08', 120
);

-- EXPECTED: exactly one of A/B has status='pending'; the other has
-- status='blocked', blocked_reason='BUDGET_EXCEEDED'. The budget can no
-- longer be oversubscribed by a concurrent pair — this scenario is expected
-- to PASS (unlike in the first delivery, where it was documented as a known
-- failure).

SELECT reserved_cost_usd FROM public.ai_gateway_budget_buckets WHERE scope_key = 'manual-validation-scenario5';
-- EXPECTED: 0.08 (only the winner's estimate), never 0.16.

-- Cleanup:
DELETE FROM public.usage_reservation_items WHERE reservation_id IN (
  SELECT id FROM public.usage_reservations WHERE idempotency_key LIKE 'manual-validation-scenario5-%'
);
DELETE FROM public.ai_gateway_reservation_budget_links WHERE reservation_id IN (
  SELECT id FROM public.usage_reservations WHERE idempotency_key LIKE 'manual-validation-scenario5-%'
);
DELETE FROM public.usage_reservations WHERE idempotency_key LIKE 'manual-validation-scenario5-%';
DELETE FROM public.ai_gateway_budget_buckets WHERE scope_key = 'manual-validation-scenario5' AND scope_type = 'feature';

-- ─────────────────────────────────────────────────────────────────────────────
-- SCENARIO 6: record_gateway_breaker_outcome_v1 — half_open probe exclusivity
-- ─────────────────────────────────────────────────────────────────────────────
-- Claim: in half_open state with half_open_probe_count=1, only one
-- concurrent caller can ever receive probe_allowed=true from
-- get_gateway_breaker_state_v1 — the row lock (FOR UPDATE) inside the
-- function serializes concurrent readers.
--
-- Isolation: feature_key must be real (FK), but model is an obviously-fake
-- marker string — ai_gateway_circuit_breakers is keyed by
-- (provider, model, feature_key), so this can never be the same row a real
-- 'writing.correct'/'gpt-4o-mini' call would use.

-- Force the breaker open first (5 consecutive failures, default threshold):
SELECT public.record_gateway_breaker_outcome_v1('openai', 'preflight-validation-model', 'writing.correct', false) FROM generate_series(1, 5);
-- Manually backdate opened_at so the cooldown has already elapsed (default 30s):
UPDATE public.ai_gateway_circuit_breakers
  SET opened_at = NOW() - INTERVAL '1 minute'
  WHERE provider = 'openai' AND model = 'preflight-validation-model' AND feature_key = 'writing.correct';

-- SESSION A:
SELECT * FROM public.get_gateway_breaker_state_v1('openai', 'preflight-validation-model', 'writing.correct');
-- SESSION B (run immediately after A transitions it to half_open):
SELECT * FROM public.get_gateway_breaker_state_v1('openai', 'preflight-validation-model', 'writing.correct');

-- EXPECTED: exactly one of A/B has probe_allowed=true; the other (whichever
-- runs after the probe slot is claimed) has probe_allowed=false. If both
-- show true, the claim is FALSE.

-- Cleanup:
DELETE FROM public.ai_gateway_circuit_breakers WHERE provider = 'openai' AND model = 'preflight-validation-model' AND feature_key = 'writing.correct';

-- ─────────────────────────────────────────────────────────────────────────────
-- SCENARIO 7: bootstrap/backfill — a bucket created mid-period is not blind
-- ─────────────────────────────────────────────────────────────────────────────
-- Claim: the first time a quota bucket is touched for a given
-- (subject, feature, metric, period), _gateway_touch_quota_bucket_v1
-- backfills committed_quantity from real ai_usage_event_metrics rows
-- already in that period window, rather than starting at 0 and ignoring
-- consumption that happened before the bucket-tracking system existed.
--
-- Isolation: the seeded ai_usage_events/ai_usage_event_metrics rows use
-- your disposable test user and a period window in year 2099 — this can
-- never overlap a real event's real started_at, so the backfill SUM only
-- ever picks up the one synthetic row this scenario inserts. A FIXED,
-- obviously-synthetic UUID (not gen_random_uuid()) is used for the event id
-- so cleanup can target it directly without needing psql's \gset (which the
-- Supabase Studio SQL editor does not support — this file must work in
-- either).
INSERT INTO public.ai_usage_events (
  id, request_id, user_id, actor_type, feature_key, provider, execution_location, status, is_billable, started_at
) VALUES (
  'aaaaaaaa-0000-0000-0000-000000000007'::uuid, 'aaaaaaaa-0000-0000-0000-000000000007'::uuid,
  (SELECT test_user_id FROM _mv_config), 'user', 'writing.correct', 'openai', 'backend', 'succeeded', true, '2099-01-15T00:00:00Z'
);

INSERT INTO public.ai_usage_event_metrics (usage_event_id, metric_key, unit_type, quantity, is_billable, measurement_source)
VALUES ('aaaaaaaa-0000-0000-0000-000000000007'::uuid, 'output_text_tokens', 'token', 750, true, 'provider_response');

SELECT * FROM public.reserve_gateway_usage_v1(
  'manual-validation-scenario7', (SELECT test_user_id FROM _mv_config), NULL, 'writing.correct', 'openai', 'preflight-validation-model',
  '[{"quota_key":"output_text_tokens","unit_type":"token","reserved_quantity":100,"limit_quantity":10000,"period_type":"month","period_start":"2099-01-01T00:00:00Z","period_end":"2099-02-01T00:00:00Z"}]'::jsonb,
  '[]'::jsonb, NULL, 120
);

SELECT committed_quantity, backfilled FROM public.ai_gateway_quota_buckets
  WHERE subject_id = (SELECT test_user_id FROM _mv_config) AND metric_key = 'output_text_tokens' AND period_start = '2099-01-01T00:00:00Z';
-- EXPECTED: committed_quantity = 750 (the backfilled historical row, not 0), backfilled = true.

-- Cleanup:
DELETE FROM public.usage_reservation_items WHERE reservation_id IN (
  SELECT id FROM public.usage_reservations WHERE idempotency_key = 'manual-validation-scenario7'
);
DELETE FROM public.usage_reservations WHERE idempotency_key = 'manual-validation-scenario7';
DELETE FROM public.ai_gateway_quota_buckets
  WHERE subject_id = (SELECT test_user_id FROM _mv_config) AND period_start = '2099-01-01T00:00:00Z';
DELETE FROM public.ai_usage_event_metrics WHERE usage_event_id = 'aaaaaaaa-0000-0000-0000-000000000007'::uuid;
DELETE FROM public.ai_usage_events WHERE id = 'aaaaaaaa-0000-0000-0000-000000000007'::uuid;

-- ─────────────────────────────────────────────────────────────────────────────
-- FINAL CLEANUP
-- ─────────────────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS _mv_config;
-- If you created a disposable auth.users row solely for this file, delete
-- it now via Supabase Studio / `supabase auth admin delete-user` — this
-- script never deletes auth.users rows itself (too destructive to automate
-- blindly against a table it doesn't own).

-- =============================================================================
-- SUMMARY — fill in after actually running the above against a real Postgres.
-- CONCURRENCY IS NOT VALIDATED. Every line below must stay "NOT EXECUTED"
-- until a human (or CI with a real disposable database) actually runs this
-- file and records the real result — do not edit this section to claim a
-- pass without having run it.
-- =============================================================================
-- Scenario 1 (rate limit atomic):                    NOT EXECUTED.
-- Scenario 2 (dedupe atomic):                         NOT EXECUTED.
-- Scenario 3 (reservation idempotency):               NOT EXECUTED.
-- Scenario 4 (600 session_seconds/month acceptance):  NOT EXECUTED.
-- Scenario 5 (budget last-dollar race — now atomic):  NOT EXECUTED.
-- Scenario 6 (breaker probe exclusivity):             NOT EXECUTED.
-- Scenario 7 (backfill on first bucket touch):        NOT EXECUTED.
--
-- All seven scenarios' SQL was written and reasoned through against the
-- exact function bodies in 20260718000000_ai_gateway_enforcement.sql
-- (single-statement INSERT ... ON CONFLICT / unique-index-plus-exception /
-- SELECT ... FOR UPDATE row-lock patterns — each a well-established
-- Postgres atomicity idiom, and scenarios 4/5 specifically exercise the
-- deterministic lock ordering — metrics sorted by quota_key, budget scopes
-- sorted by a fixed scope_type precedence — that prevents two concurrent
-- transactions from deadlocking each other while both hold multiple row
-- locks), but "reasoned through" is not the same as "proven by execution."
-- No feature may be classified enforce_ready, and enforce must not be
-- activated for any feature, until this file has actually been run against
-- a real Postgres and every scenario above is updated from "NOT EXECUTED"
-- to a real PASS/FAIL with the actual output attached.
-- =============================================================================
