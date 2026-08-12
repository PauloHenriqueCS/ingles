-- Subscription plan-change modeling on user_plan_assignments.
--
-- Context: a Google Play DEFERRED downgrade (Plus -> Essencial) keeps the
-- current product (Plus) active until the period end and schedules the new
-- product for the next renewal. RevenueCat surfaces this two ways:
--   * REST subscriber snapshot: sets unsubscribe_detected_at on the current
--     product ("won't auto-renew as-is") but NEVER names the pending target.
--   * PRODUCT_CHANGE webhook: carries new_product_id — the ONLY authoritative
--     signal for which plan is scheduled next.
--
-- Previously the REST reconcile mapped unsubscribe_detected_at -> cancelled_at,
-- so an active subscription with a pending downgrade was rendered as
-- "Assinatura cancelada". These columns let the backend model the real state:
--   * auto_renew          — false once the current product won't auto-renew
--                            (from REST unsubscribe_detected_at). Drives the
--                            honest "não renova / acesso até DD/MM" fallback.
--   * pending_plan_id      — the scheduled next plan, set ONLY from the
--                            PRODUCT_CHANGE webhook's new_product_id (never
--                            guessed from unsubscribe_detected_at).
--   * pending_effective_at — when the pending plan takes effect (= the current
--                            product's period end / expiration).
--
-- All additive and nullable/defaulted — no backfill, no rewrite. cancelled_at
-- keeps its existing meaning (a real CANCELLATION, no pending change).

alter table public.user_plan_assignments
  add column if not exists auto_renew boolean not null default true,
  add column if not exists pending_plan_id uuid null references public.plans(id),
  add column if not exists pending_effective_at timestamptz null;

comment on column public.user_plan_assignments.auto_renew is
  'False when the store reports the current product will not auto-renew as-is (RevenueCat unsubscribe_detected_at). Distinct from cancelled_at: access continues until ends_at either way.';
comment on column public.user_plan_assignments.pending_plan_id is
  'The plan scheduled to take effect at the next renewal (Google Play DEFERRED change). Set ONLY from the PRODUCT_CHANGE webhook new_product_id — never inferred from unsubscribe_detected_at.';
comment on column public.user_plan_assignments.pending_effective_at is
  'When pending_plan_id takes effect (the current product period end). Null when no pending change.';

-- Resolves the effective assignment row for the pending display, so the read
-- in subscription-status-service stays a single indexed lookup.
create index if not exists idx_upa_pending_plan
  on public.user_plan_assignments (user_id)
  where pending_plan_id is not null;
