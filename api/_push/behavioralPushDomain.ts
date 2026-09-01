/**
 * SERVER-ONLY, PURE domain logic for behavioral (behaviour-triggered) push.
 *
 * This module has NO Node, env, network or Supabase dependency — it is a pure
 * function layer so the eligibility rules can be exhaustively unit-tested. It
 * deliberately REUSES the exact streak math the Home screen uses
 * (computeWeekdayStreak from src/lib/metricsCore) instead of re-deriving it —
 * there must never be two streak algorithms (Home saying "8 dias" while the
 * push backend computes "7"). See docs/behavioral-push.md.
 *
 * Two push types only (v1):
 *   - 'streak_risk'  : the user has a live streak that today (a configured
 *                      practice day) would break if they don't practice.
 *   - 'abandonment'  : the user has missed >= N consecutive CONFIGURED practice
 *                      days without completing a valid activity.
 * Priority when both apply: streak_risk > abandonment. Never both.
 */

import { computeWeekdayStreak } from '../../src/lib/metricsCore';

/** Domain constants. Centralized here so a single edit changes behaviour
 *  everywhere (spec: "Centralize o número 2", "não espalhe 24/72 pelo código"). */
export const BEHAVIORAL_PUSH = {
  /** Global cooldown between ANY two behavioral pushes for a user, in hours.
   *  Applies across both types (a streak_risk starts the cooldown for a later
   *  abandonment too). Only a genuinely SENT push starts it.
   *  ⚠️ TEMP (homolog streak_risk test 2026-09-01): lowered 72 → 1 to bypass the
   *  cooldown from the abandonment test. REVERT to 72 after the test. */
  COOLDOWN_HOURS: 1,
  /** Consecutive missed CONFIGURED practice days required before 'abandonment'
   *  becomes eligible. Domain constant so it is trivially tunable later. */
  MISSED_PRACTICE_DAYS_FOR_ABANDONMENT: 2,
  /** Attribution window after a SENT push during which a completed activity is
   *  associated with it (association, NOT causality). Hours. */
  ATTRIBUTION_WINDOW_HOURS: 24,
  /** Product rule: evaluate/send at ~20:00 America/Sao_Paulo. The sweep only
   *  claims a user when the São Paulo local hour is inside [START, END]. */
  EVAL_HOUR_SP_START: 20,
  EVAL_HOUR_SP_END: 20, // inclusive; the 20:00–20:59 window
  /** How many days of activity history to load for streak + missed-day math.
   *  120 comfortably covers any realistic streak and the abandonment lookback. */
  STREAK_LOOKBACK_DAYS: 120,
  /** Max users processed per sweep tick (bounded; the sweep paginates). */
  SWEEP_BATCH_SIZE: 200,
} as const;

export type BehavioralPushType = 'streak_risk' | 'abandonment';

export interface BehavioralPushCandidateInput {
  userId: string;
  /** Configured practice weekdays, convention 0=Sun..6=Sat
   *  (user_learning_settings.active_weekdays — the same set the streak uses). */
  activeWeekdays: number[];
  /** YYYY-MM-DD São Paulo dates with a completed valid activity, using the
   *  SAME strict active-day rule as the Home streak (conversation counts only
   *  when the daily-minutes goal was met). Feeds both the streak and the
   *  missed-day count. */
  activeDates: string[];
  /** Generous "did the user do anything today?" flag used ONLY for the
   *  don't-nag gate — a single completed activity of any kind today (including
   *  a below-goal conversation) sets this true. Kept distinct from the strict
   *  active-day rule above on purpose (product decision). */
  practicedToday: boolean;
  /** YYYY-MM-DD São Paulo date the user's account was created. Reference start
   *  for the abandonment count when the user has never practiced. */
  accountCreatedDate: string;
  /** YYYY-MM-DD São Paulo date the sweep is evaluating ("today"). */
  localDate: string;
}

export interface BehavioralPushDecision {
  pushType: BehavioralPushType | null;
  /** Streak as of localDate (identical to what Home would show). */
  streak: number;
  /** Consecutive missed configured practice days (0 when not abandonment). */
  missedStudyDays: number;
}

/** Weekday (0=Sun..6=Sat) of a YYYY-MM-DD date, timezone-independent. */
export function weekdayOf(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Add `days` to a YYYY-MM-DD date, returning a YYYY-MM-DD date. */
function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Count CONFIGURED practice weekdays in the interval
 * (afterDateExclusive, throughDateInclusive] that are NOT in activeDates.
 *
 * Because every configured day AFTER the user's last active date is by
 * definition missed, this equals the run of consecutive missed practice days.
 * `throughDateInclusive` is normally `today` — the spec counts today itself as
 * a missed day when today is a configured practice day and the user has not
 * practiced yet by 20:00 (the Wed-at-20h example in the brief).
 */
export function countMissedConfiguredDays(
  activeWeekdays: number[],
  activeDates: string[],
  afterDateExclusive: string,
  throughDateInclusive: string,
): number {
  if (activeWeekdays.length === 0) return 0;
  const weekdaySet = new Set(activeWeekdays);
  const activeSet = new Set(activeDates);
  let count = 0;
  let cursor = addDays(afterDateExclusive, 1);
  // Guard against pathological inputs (bad dates) — never loop unbounded.
  for (let guard = 0; guard < 400 && cursor <= throughDateInclusive; guard++) {
    if (weekdaySet.has(weekdayOf(cursor)) && !activeSet.has(cursor)) count++;
    cursor = addDays(cursor, 1);
  }
  return count;
}

/**
 * Decide which behavioral push (if any) applies. Pure — all the environmental
 * gates (cooldown, entitlement, exclusions, dry-run, timezone window) are
 * enforced by the sweep around this. This only encodes the streak_risk vs
 * abandonment product rules and their priority.
 */
export function decideBehavioralPush(input: BehavioralPushCandidateInput): BehavioralPushDecision {
  const streak = computeWeekdayStreak(input.activeDates, input.localDate, input.activeWeekdays);

  // Already practiced today → never a behavioral push (server-authoritative
  // don't-nag rule). Belt-and-suspenders: the sweep pre-filters these out too.
  if (input.practicedToday) {
    return { pushType: null, streak, missedStudyDays: 0 };
  }

  // Global rule: only ever send on a CONFIGURED practice day. This is enforced
  // in SQL too (candidates pre-filter), but keeping it here makes the decision
  // self-contained and correct for both types.
  const todayIsConfigured = input.activeWeekdays.includes(weekdayOf(input.localDate));
  if (!todayIsConfigured) {
    return { pushType: null, streak, missedStudyDays: 0 };
  }

  // ── streak_risk (priority 1) ────────────────────────────────────────────
  // A live streak (>0) on a configured practice day that has not been
  // completed yet would break the moment today passes as a missed weekday.
  if (streak > 0) {
    return { pushType: 'streak_risk', streak, missedStudyDays: 0 };
  }

  // ── abandonment (priority 2) ────────────────────────────────────────────
  const lastActive = input.activeDates.length
    ? input.activeDates.reduce((a, b) => (a > b ? a : b))
    : null;
  const reference = lastActive ?? input.accountCreatedDate;
  const missed = countMissedConfiguredDays(
    input.activeWeekdays,
    input.activeDates,
    reference,
    input.localDate,
  );
  if (missed >= BEHAVIORAL_PUSH.MISSED_PRACTICE_DAYS_FOR_ABANDONMENT) {
    return { pushType: 'abandonment', streak, missedStudyDays: missed };
  }

  return { pushType: null, streak, missedStudyDays: missed };
}
