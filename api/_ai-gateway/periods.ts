/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 *
 * Shared period-boundary computation for the Etapa 11 enforcement layer.
 * Both entitlements.ts (quota buckets) and enforcement.ts (budget buckets)
 * need "what is the start/end of the period this limit resets on" — this is
 * the single place that decides it, so day/month/assignment-cycle math is
 * never duplicated (and never drifts) across the two call sites.
 *
 * period_start/period_end are always computed here in TypeScript and passed
 * as-is into the SQL RPCs (reserve_gateway_usage_v1's p_metrics/
 * p_budget_scopes) — the SQL layer never computes a calendar boundary
 * itself, so there is exactly one implementation of "what period is this."
 */

export type BucketPeriodType = 'day' | 'week' | 'month' | 'lifetime' | 'assignment_cycle';

export interface PeriodBounds {
  periodType: BucketPeriodType;
  periodStart: string; // ISO
  periodEnd: string;   // ISO
}

const LIFETIME_EPOCH = new Date(0).toISOString();
// Far enough in the future to act as "no reset", without using a sentinel
// that could collide with a real date (e.g. 9999-12-31 is sometimes used as
// NULL-like in other systems — this app doesn't, but a concrete finite date
// is still safer than relying on TIMESTAMPTZ 'infinity' round-tripping
// cleanly through JSON/JS Date, which it does not).
const LIFETIME_HORIZON = new Date(Date.UTC(2999, 0, 1)).toISOString();

export function dayBoundsUtc(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

export function weekBoundsUtc(now: Date): { start: Date; end: Date } {
  // ISO week: Monday 00:00:00 UTC through the following Monday.
  const day = now.getUTCDay(); // 0=Sunday..6=Saturday
  const daysSinceMonday = (day + 6) % 7;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMonday));
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { start, end };
}

export function monthBoundsUtc(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

/**
 * Resolves the [start, end) window a given EntitlementLimit.period /
 * BudgetPeriod value falls in, for "now". 'assignment_cycle' requires the
 * caller to supply the real assignment window (from user_plan_assignments —
 * entitlements.ts is the only place with that data); if absent, falls back
 * to a calendar month (never throws — a missing assignment window must
 * degrade to a safe, still-real period rather than blocking resolution).
 * 'none'/'request'/'lifetime' collapse to a single open-ended bucket
 * (period_start = epoch) since there's nothing periodic to reset — the
 * per-call ceiling remains the only protection for those, by design.
 */
export function resolvePeriodBounds(
  period: 'none' | 'request' | 'day' | 'week' | 'month' | 'lifetime' | 'assignment_cycle',
  now: Date,
  assignmentWindow?: { startsAt: string | null; endsAt: string | null } | null,
): PeriodBounds | null {
  if (period === 'none' || period === 'request') return null; // no periodic bucket — per-call ceiling only

  if (period === 'lifetime') {
    return { periodType: 'lifetime', periodStart: LIFETIME_EPOCH, periodEnd: LIFETIME_HORIZON };
  }

  if (period === 'assignment_cycle') {
    if (assignmentWindow?.startsAt) {
      return {
        periodType: 'assignment_cycle',
        periodStart: assignmentWindow.startsAt,
        periodEnd: assignmentWindow.endsAt ?? LIFETIME_HORIZON,
      };
    }
    // No assignment window available — fall back to calendar month rather
    // than failing resolution outright.
    const { start, end } = monthBoundsUtc(now);
    return { periodType: 'month', periodStart: start.toISOString(), periodEnd: end.toISOString() };
  }

  if (period === 'day') {
    const { start, end } = dayBoundsUtc(now);
    return { periodType: 'day', periodStart: start.toISOString(), periodEnd: end.toISOString() };
  }
  if (period === 'week') {
    const { start, end } = weekBoundsUtc(now);
    return { periodType: 'week', periodStart: start.toISOString(), periodEnd: end.toISOString() };
  }
  // period === 'month'
  const { start, end } = monthBoundsUtc(now);
  return { periodType: 'month', periodStart: start.toISOString(), periodEnd: end.toISOString() };
}
