/**
 * SERVER-ONLY, PURE domain logic for behavioral (behaviour-triggered) push.
 *
 * This module has NO Node, env, network or Supabase dependency — it is a pure
 * function layer so the eligibility rules can be exhaustively unit-tested.
 *
 * v2 (2026-09) — SIMPLE DAILY REMINDER. The product rule is now:
 *
 *   "Todo dia de prática, às 20h SP, se o usuário ainda não praticou, ele pode
 *    receber 1 push. Todos recebem a MESMA frase naquele dia; no dia seguinte a
 *    frase muda. Se já estudou, silêncio total."
 *
 * A eligibilidade NÃO depende mais de streak nem de abandono. O único tipo v2 é
 * 'practice_reminder_behavioral'. Os tipos antigos 'streak_risk'/'abandonment'
 * permanecem na UNION apenas por compatibilidade com o histórico (eventos já
 * gravados + a copy legada em behavioralPushCopy) — nunca são mais PRODUZIDOS
 * por decideBehavioralPush.
 *
 * streak continua sendo computado (reutilizando computeWeekdayStreak da Home,
 * jamais um segundo algoritmo) apenas como SNAPSHOT para análise futura no
 * Dashboard; não influencia a decisão nem a copy. See docs/behavioral-push.md.
 */

import { computeWeekdayStreak } from '../../src/lib/metricsCore';

/** Domain constants. Centralized here so a single edit changes behaviour
 *  everywhere. */
export const BEHAVIORAL_PUSH = {
  /** Attribution window after a SENT push during which a completed activity is
   *  associated with it (association, NOT causality). Hours. */
  ATTRIBUTION_WINDOW_HOURS: 24,
  /** Product rule: evaluate/send at ~20:00 America/Sao_Paulo. The sweep only
   *  claims a user when the São Paulo local hour is inside [START, END]. */
  EVAL_HOUR_SP_START: 20,
  EVAL_HOUR_SP_END: 20, // inclusive; the 20:00–20:59 window
  /** Window (days) over which the SQL candidate query computes its SNAPSHOTS
   *  (streak + last_activity). This is NOT an eligibility gate — dormancy never
   *  excludes a user (owner decision 2026-09-11). A user inactive for 31/60/90
   *  days is still eligible; the snapshot for them is simply empty. */
  SNAPSHOT_LOOKBACK_DAYS: 30,
  /** Rows fetched per keyset page. Small enough to keep the time-budget check
   *  fine-grained and each candidates query cheap; the sweep pages until the
   *  population is drained or the time budget runs out — there is NO fixed cap
   *  on total users per invocation. */
  SWEEP_BATCH_SIZE: 100,
  /** Wall-clock budget (ms) for a single sweep invocation. Vercel maxDuration is
   *  300s (see vercel.json); we stop cleanly well under it, reporting hasMore +
   *  nextCursor so a later invocation resumes. pg_cron calls via pg_net
   *  fire-and-forget, so the function owns the full 300s. */
  SWEEP_TIME_BUDGET_MS: 240_000,
  /** Absolute backstop on pages per invocation — a runaway guard only, set far
   *  above any real population reachable inside the time budget (100 * 100k =
   *  10M users). The real stop conditions are "drained" or "time budget". */
  SWEEP_SAFETY_MAX_BATCHES: 100_000,
} as const;

/** 'practice_reminder_behavioral' is the only type produced in v2; the other two
 *  are kept for historical rows and the legacy copy builder. */
export type BehavioralPushType = 'streak_risk' | 'abandonment' | 'practice_reminder_behavioral';

/** The single push type produced by the daily-reminder strategy (v2). */
export const DAILY_PRACTICE_PUSH_TYPE: BehavioralPushType = 'practice_reminder_behavioral';

export interface BehavioralPushCandidateInput {
  userId: string;
  /** Configured practice weekdays, convention 0=Sun..6=Sat
   *  (user_learning_settings.active_weekdays — the same set the streak uses). */
  activeWeekdays: number[];
  /** YYYY-MM-DD São Paulo dates with a completed valid activity (strict active-day
   *  rule, same as the Home streak). Feeds the streak SNAPSHOT only. */
  activeDates: string[];
  /** Generous "did the user do anything today?" flag used for the don't-nag
   *  gate — a single completed activity of any kind today (including a
   *  below-goal conversation) sets this true. */
  practicedToday: boolean;
  /** YYYY-MM-DD São Paulo date the user's account was created. Kept for the
   *  candidate shape; not used by the decision in v2. */
  accountCreatedDate: string;
  /** YYYY-MM-DD São Paulo date the sweep is evaluating ("today"). */
  localDate: string;
}

export interface BehavioralPushDecision {
  pushType: BehavioralPushType | null;
  /** Streak as of localDate (identical to what Home would show) — SNAPSHOT only. */
  streak: number;
  /** Kept for the row snapshot; always 0 in v2 (no abandonment math). */
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
 * Pure utility retained for analytics/tests. No longer part of the eligibility
 * decision in v2 (abandonment logic was removed), but kept because it is a
 * correct, well-tested weekday-counting helper.
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
 * Decide whether the daily practice-reminder push applies (v2). Pure — all the
 * environmental gates (entitlement, exclusions, idempotency, dry-run, timezone
 * window) are enforced by the sweep + SQL around this.
 *
 * Rule: eligible iff (a) the user has NOT practiced today AND (b) today is a
 * configured practice weekday. No streak/abandonment gating. `streak` is still
 * returned as a snapshot for analytics.
 */
export function decideBehavioralPush(input: BehavioralPushCandidateInput): BehavioralPushDecision {
  const streak = computeWeekdayStreak(input.activeDates, input.localDate, input.activeWeekdays);

  // Already practiced today → never a behavioral push (server-authoritative
  // don't-nag rule). Belt-and-suspenders: the sweep pre-filters these out too.
  if (input.practicedToday) {
    return { pushType: null, streak, missedStudyDays: 0 };
  }

  // Only ever send on a CONFIGURED practice day (also enforced in SQL).
  const todayIsConfigured = input.activeWeekdays.includes(weekdayOf(input.localDate));
  if (!todayIsConfigured) {
    return { pushType: null, streak, missedStudyDays: 0 };
  }

  return { pushType: DAILY_PRACTICE_PUSH_TYPE, streak, missedStudyDays: 0 };
}
