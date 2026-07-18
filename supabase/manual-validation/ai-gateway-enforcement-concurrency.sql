-- =============================================================================
-- MANUAL VALIDATION: AI Gateway enforcement — concurrency scenarios
-- Etapa 11, Fase 15 (updated for the "close enforcement readiness gaps"
-- correction — budget is no longer a separate, racy round trip; it is
-- validated and reserved atomically inside reserve_gateway_usage_v1
-- alongside quota, under deterministically-ordered row locks).
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
-- FEATURE). Every scenario here only touches Etapa-11-owned tables — safe
-- to run repeatedly and to clean up via the DELETE statements at the end of
-- each section.
-- =============================================================================

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

-- SESSION A:
SELECT * FROM public.reserve_gateway_usage_v1(
  'preflight-validation-scenario3', NULL, NULL, 'writing.correct', 'openai', 'gpt-4o-mini',
  '[{"quota_key":"output_text_tokens","unit_type":"token","reserved_quantity":500,"limit_quantity":null,"period_type":null,"period_start":null,"period_end":null}]'::jsonb,
  '[]'::jsonb, NULL, 120
);

-- SESSION B (run immediately):
SELECT * FROM public.reserve_gateway_usage_v1(
  'preflight-validation-scenario3', NULL, NULL, 'writing.correct', 'openai', 'gpt-4o-mini',
  '[{"quota_key":"output_text_tokens","unit_type":"token","reserved_quantity":500,"limit_quantity":null,"period_type":null,"period_start":null,"period_end":null}]'::jsonb,
  '[]'::jsonb, NULL, 120
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
-- SCENARIO 4: mandatory acceptance test — 600 session_seconds/month quota
-- ─────────────────────────────────────────────────────────────────────────────
-- Etapa 11 correction, §1's own required acceptance case. Proves quota is
-- accumulated (committed + reserved vs. limit), not just a per-call
-- ceiling, and that two concurrent calls near the remaining balance cannot
-- both win.
--
-- Setup: a bucket already at committed=300, reserved=250 (out of a 600
-- limit — 50 remaining) is seeded directly (simulating prior real usage +
-- an existing in-flight reservation), then two concurrent 40-second
-- attempts race the remaining 50.

INSERT INTO public.ai_gateway_quota_buckets (
  subject_type, subject_id, feature_key, metric_key, period_type, period_start, period_end,
  committed_quantity, reserved_quantity
) VALUES (
  'user', '00000000-0000-0000-0000-000000000002', 'conversation.realtime_usage', 'session_seconds', 'month',
  '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z', 300, 250
);

-- SESSION A:
SELECT * FROM public.reserve_gateway_usage_v1(
  'preflight-validation-scenario4-a', '00000000-0000-0000-0000-000000000002', NULL,
  'conversation.realtime_usage', 'openai', 'gpt-realtime-2.1-mini',
  '[{"quota_key":"session_seconds","unit_type":"second","reserved_quantity":40,"limit_quantity":600,"period_type":"month","period_start":"2026-07-01T00:00:00Z","period_end":"2026-08-01T00:00:00Z"}]'::jsonb,
  '[]'::jsonb, NULL, 120
);

-- SESSION B (run immediately, before A's transaction commits):
SELECT * FROM public.reserve_gateway_usage_v1(
  'preflight-validation-scenario4-b', '00000000-0000-0000-0000-000000000002', NULL,
  'conversation.realtime_usage', 'openai', 'gpt-realtime-2.1-mini',
  '[{"quota_key":"session_seconds","unit_type":"second","reserved_quantity":40,"limit_quantity":600,"period_type":"month","period_start":"2026-07-01T00:00:00Z","period_end":"2026-08-01T00:00:00Z"}]'::jsonb,
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
  WHERE subject_id = '00000000-0000-0000-0000-000000000002' AND metric_key = 'session_seconds';
-- EXPECTED: reserved_quantity = 290 (250 + exactly one winning 40), never 330.

-- Finalize the winning reservation with real usage of 20 (less than the 40
-- reserved) — proves the 20-second difference is returned to the bucket:
-- SELECT public.commit_gateway_reservation_v1(
--   '<winning reservation_id from above>', gen_random_uuid(), NULL,
--   '[{"quota_key":"session_seconds","actual_quantity":20}]'::jsonb
-- );
-- SELECT reserved_quantity, committed_quantity FROM public.ai_gateway_quota_buckets
--   WHERE subject_id = '00000000-0000-0000-0000-000000000002' AND metric_key = 'session_seconds';
-- EXPECTED: reserved_quantity back down to 250 (290 - 40 released), committed_quantity = 320 (300 + 20 real).

-- Cleanup:
DELETE FROM public.usage_reservation_items WHERE reservation_id IN (
  SELECT id FROM public.usage_reservations WHERE idempotency_key LIKE 'preflight-validation-scenario4-%'
);
DELETE FROM public.usage_reservations WHERE idempotency_key LIKE 'preflight-validation-scenario4-%';
DELETE FROM public.ai_gateway_quota_buckets WHERE subject_id = '00000000-0000-0000-0000-000000000002';

-- ─────────────────────────────────────────────────────────────────────────────
-- SCENARIO 5: budget last-dollar race — CLOSED by this correction
-- ─────────────────────────────────────────────────────────────────────────────
-- The original Etapa 11 delivery admitted this as a known, unfixed gap
-- (budget check and reserve were two separate round trips). This
-- correction folds budget validation into the SAME atomic
-- reserve_gateway_usage_v1 transaction as quota, under the same
-- deterministic lock ordering — this scenario proves it.
--
-- Setup: a budget bucket already at committed=0.90, reserved=0.00 against a
-- $1.00 daily limit ($0.10 remaining). Two concurrent calls each estimate
-- $0.08 — individually within budget (0.90+0.08=0.98<=1.00) but not
-- together (0.90+0.08+0.08=1.06>1.00).

INSERT INTO public.ai_gateway_budget_buckets (scope_type, scope_key, period_type, period_start, period_end, committed_cost_usd, reserved_cost_usd)
VALUES ('feature', 'writing.correct', 'day', '2026-07-18T00:00:00Z', '2026-07-19T00:00:00Z', 0.90, 0.00);

-- SESSION A:
SELECT * FROM public.reserve_gateway_usage_v1(
  'preflight-validation-scenario5-a', NULL, NULL, 'writing.correct', 'openai', 'gpt-4o-mini',
  '[{"quota_key":"provider_requests","unit_type":"request","reserved_quantity":1,"limit_quantity":null,"period_type":null,"period_start":null,"period_end":null}]'::jsonb,
  '[{"scope_type":"feature","scope_key":"writing.correct","period_type":"day","period_start":"2026-07-18T00:00:00Z","period_end":"2026-07-19T00:00:00Z","limit_usd":"1.00"}]'::jsonb,
  '0.08', 120
);

-- SESSION B (run immediately):
SELECT * FROM public.reserve_gateway_usage_v1(
  'preflight-validation-scenario5-b', NULL, NULL, 'writing.correct', 'openai', 'gpt-4o-mini',
  '[{"quota_key":"provider_requests","unit_type":"request","reserved_quantity":1,"limit_quantity":null,"period_type":null,"period_start":null,"period_end":null}]'::jsonb,
  '[{"scope_type":"feature","scope_key":"writing.correct","period_type":"day","period_start":"2026-07-18T00:00:00Z","period_end":"2026-07-19T00:00:00Z","limit_usd":"1.00"}]'::jsonb,
  '0.08', 120
);

-- EXPECTED: exactly one of A/B has status='pending'; the other has
-- status='blocked', blocked_reason='BUDGET_EXCEEDED'. The budget can no
-- longer be oversubscribed by a concurrent pair — CONCLUSION: this scenario
-- is now expected to PASS (unlike the original delivery, where it was
-- documented as a known failure).

SELECT reserved_cost_usd FROM public.ai_gateway_budget_buckets WHERE scope_key = 'writing.correct';
-- EXPECTED: 0.08 (only the winner's estimate), never 0.16.

-- Cleanup:
DELETE FROM public.usage_reservation_items WHERE reservation_id IN (
  SELECT id FROM public.usage_reservations WHERE idempotency_key LIKE 'preflight-validation-scenario5-%'
);
DELETE FROM public.ai_gateway_reservation_budget_links WHERE reservation_id IN (
  SELECT id FROM public.usage_reservations WHERE idempotency_key LIKE 'preflight-validation-scenario5-%'
);
DELETE FROM public.usage_reservations WHERE idempotency_key LIKE 'preflight-validation-scenario5-%';
DELETE FROM public.ai_gateway_budget_buckets WHERE scope_key = 'writing.correct' AND scope_type = 'feature';

-- ─────────────────────────────────────────────────────────────────────────────
-- SCENARIO 6: record_gateway_breaker_outcome_v1 — half_open probe exclusivity
-- ─────────────────────────────────────────────────────────────────────────────
-- Claim: in half_open state with half_open_probe_count=1, only one
-- concurrent caller can ever receive probe_allowed=true from
-- get_gateway_breaker_state_v1 — the row lock (FOR UPDATE) inside the
-- function serializes concurrent readers.

-- Force the breaker open first (5 consecutive failures, default threshold):
SELECT public.record_gateway_breaker_outcome_v1('openai', 'gpt-4o-mini', 'preflight-validation-scenario6', false) FROM generate_series(1, 5);
-- Manually backdate opened_at so the cooldown has already elapsed (default 30s):
UPDATE public.ai_gateway_circuit_breakers
  SET opened_at = NOW() - INTERVAL '1 minute'
  WHERE provider = 'openai' AND model = 'gpt-4o-mini' AND feature_key = 'preflight-validation-scenario6';

-- SESSION A:
SELECT * FROM public.get_gateway_breaker_state_v1('openai', 'gpt-4o-mini', 'preflight-validation-scenario6');
-- SESSION B (run immediately after A transitions it to half_open):
SELECT * FROM public.get_gateway_breaker_state_v1('openai', 'gpt-4o-mini', 'preflight-validation-scenario6');

-- EXPECTED: exactly one of A/B has probe_allowed=true; the other (whichever
-- runs after the probe slot is claimed) has probe_allowed=false. If both
-- show true, the claim is FALSE.

-- Cleanup:
DELETE FROM public.ai_gateway_circuit_breakers WHERE feature_key = 'preflight-validation-scenario6';

-- ─────────────────────────────────────────────────────────────────────────────
-- SCENARIO 7: bootstrap/backfill — a bucket created mid-period is not blind
-- ─────────────────────────────────────────────────────────────────────────────
-- Claim: the first time a quota bucket is touched for a given
-- (subject, feature, metric, period), _gateway_touch_quota_bucket_v1
-- backfills committed_quantity from real ai_usage_event_metrics rows
-- already in that period window, rather than starting at 0 and ignoring
-- consumption that happened before the bucket-tracking system existed.
--
-- Setup: insert a fake historical ai_usage_events + ai_usage_event_metrics
-- row for a user/feature/metric with no existing bucket, dated inside the
-- current month, then reserve against that same metric and confirm the
-- bucket's committed_quantity reflects the historical row.

-- (Requires a real ai_provider_sessions-independent event — adjust feature_key/
-- user_id to real seed data before running.)
-- INSERT INTO public.ai_usage_events (id, request_id, user_id, actor_type, feature_key, provider, execution_location, status, is_billable, started_at)
-- VALUES (gen_random_uuid(), gen_random_uuid(), '00000000-0000-0000-0000-000000000003', 'user', 'writing.correct', 'openai', 'backend', 'succeeded', true, date_trunc('month', now()))
-- RETURNING id \gset
-- INSERT INTO public.ai_usage_event_metrics (usage_event_id, metric_key, unit_type, quantity, is_billable, measurement_source)
-- VALUES (:'id', 'output_text_tokens', 'token', 750, true, 'provider_response');
--
-- SELECT * FROM public.reserve_gateway_usage_v1(
--   'preflight-validation-scenario7', '00000000-0000-0000-0000-000000000003', NULL, 'writing.correct', 'openai', 'gpt-4o-mini',
--   ('[{"quota_key":"output_text_tokens","unit_type":"token","reserved_quantity":100,"limit_quantity":10000,"period_type":"month","period_start":"' || date_trunc('month', now())::text || '","period_end":"' || (date_trunc('month', now()) + interval '1 month')::text || '"}]')::jsonb,
--   '[]'::jsonb, NULL, 120
-- );
-- SELECT committed_quantity FROM public.ai_gateway_quota_buckets WHERE subject_id = '00000000-0000-0000-0000-000000000003' AND metric_key='output_text_tokens';
-- EXPECTED: committed_quantity = 750 (the backfilled historical row), not 0.

-- ─────────────────────────────────────────────────────────────────────────────
-- SCENARIO 8: dashboard publish → runtime materialization, and rollback
-- ─────────────────────────────────────────────────────────────────────────────
-- Claim: writing to the dashboard's authoring tables (ai_gateway_configs /
-- ai_control_switches) atomically updates ai_runtime_controls via the
-- trg_publish_runtime_controls_on_config / _on_switch triggers, and that a
-- feature-scope switch's runtime_status alone changes — never that
-- feature's gateway_mode (the dashboard has no gateway_mode source below
-- 'global' today).

-- Capture the current feature-scope row for a real feature (adjust the
-- scope_key to one of the 25 seeded feature_key values):
SELECT gateway_mode, runtime_status FROM public.ai_runtime_controls
  WHERE scope_type = 'feature' AND scope_key = 'writing.correct';
-- EXPECTED (before): gateway_mode = whatever it already is (e.g. 'observe'
-- per the live audit at the time this file was written) — note it down.

-- Admin disables the feature via a control switch (the "authoring" write):
INSERT INTO public.ai_control_switches (environment, scope, feature_key, enabled, starts_at, reason)
VALUES ('production', 'feature', 'writing.correct', false, NOW(), 'manual-validation-scenario8');

SELECT gateway_mode, runtime_status FROM public.ai_runtime_controls
  WHERE scope_type = 'feature' AND scope_key = 'writing.correct';
-- EXPECTED (after): runtime_status = 'disabled', gateway_mode UNCHANGED from
-- the "before" value noted above — the trigger never touches gateway_mode
-- for a feature-scope row (only the global row's gateway_mode is
-- dashboard-sourced, via ai_gateway_configs).

-- Rollback: revoke the switch (dashboard's own "undo" — set enabled=true or
-- revoked_at) and confirm the projection reverts:
UPDATE public.ai_control_switches
  SET enabled = true
  WHERE feature_key = 'writing.correct' AND reason = 'manual-validation-scenario8';

SELECT gateway_mode, runtime_status FROM public.ai_runtime_controls
  WHERE scope_type = 'feature' AND scope_key = 'writing.correct';
-- EXPECTED: runtime_status back to 'enabled'.

-- Global mode/emergency-stop propagation:
UPDATE public.ai_gateway_configs SET gateway_mode = 'observe', emergency_stop = true, emergency_stop_reason = 'manual-validation-scenario8' WHERE environment = 'production';
SELECT gateway_mode, runtime_status FROM public.ai_runtime_controls WHERE scope_type = 'global' AND scope_key = 'global';
-- EXPECTED: gateway_mode = 'observe', runtime_status = 'disabled' (emergency_stop forces disabled regardless of ai_enabled).

-- Cleanup (restore production's real prior state — check the very first
-- SELECT in this section before running these, do not blindly reset a real
-- environment's config to these literal values):
-- UPDATE public.ai_gateway_configs SET gateway_mode = 'legacy', emergency_stop = false, emergency_stop_reason = NULL WHERE environment = 'production';
DELETE FROM public.ai_control_switches WHERE reason = 'manual-validation-scenario8';

-- =============================================================================
-- SUMMARY (fill in after actually running the above against a real Postgres)
-- =============================================================================
-- Scenario 1 (rate limit atomic):                 NOT EXECUTED in this delivery — no local Postgres available.
-- Scenario 2 (dedupe atomic):                      NOT EXECUTED in this delivery — no local Postgres available.
-- Scenario 3 (reservation idempotency):            NOT EXECUTED in this delivery — no local Postgres available.
-- Scenario 4 (600 session_seconds/month acceptance): NOT EXECUTED in this delivery — no local Postgres available.
-- Scenario 5 (budget last-dollar race — now atomic): NOT EXECUTED in this delivery — no local Postgres available.
-- Scenario 6 (breaker probe exclusivity):          NOT EXECUTED in this delivery — no local Postgres available.
-- Scenario 7 (backfill on first bucket touch):     NOT EXECUTED in this delivery — no local Postgres available.
-- Scenario 8 (publish → runtime, rollback):        NOT EXECUTED in this delivery — no local Postgres available; DOUBLE-CHECK before running against any real environment (it writes to ai_gateway_configs/ai_control_switches, which are dashboard-owned tables shared with ingles-dashboard).
--
-- All eight scenarios' SQL was written and reasoned through against the
-- exact function bodies in 20260718000000_ai_gateway_enforcement.sql
-- (single-statement INSERT ... ON CONFLICT / unique-index-plus-exception /
-- SELECT ... FOR UPDATE row-lock patterns — each a well-established
-- Postgres atomicity idiom, and scenarios 4/5 specifically exercise the
-- deterministic lock ordering — metrics sorted by quota_key, budget scopes
-- sorted by a fixed scope_type precedence — that prevents two concurrent
-- transactions from deadlocking each other while both hold multiple row
-- locks), but "reasoned through" is not the same as "proven by execution."
-- Re-run this file against a disposable Supabase branch or local Postgres
-- before ever enabling enforce for a real feature, and update this summary
-- with actual results.
-- =============================================================================
