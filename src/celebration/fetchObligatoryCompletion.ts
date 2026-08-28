/**
 * Reads TODAY's completed-status for the three obligatory activities, reusing
 * the very same data sources the calendar uses (so the celebration's "day
 * complete?" decision can never diverge from the green-day rule):
 *
 *   - writing       → writing_entries[today] via deriveWritingActivityState
 *   - pronunciation → pronunciation_assessments + pronunciation_training_sessions
 *   - listening     → user_listening_assignments[today]
 *
 * Only the activities we still need are queried: the just-finished activity is
 * known-completed by the caller (a confirmed server persist), and disabled
 * features are skipped. Every query is best-effort — a failure resolves to
 * `false` for that activity so we can only ever UNDER-claim day completion,
 * never falsely celebrate a whole day.
 */
import { getPronunciationDatesForMonth } from '../lib/dailyProgress';
import { getListeningDatesForMonth } from '../services/listening/calendar/get-listening-calendar-activities';
import { fetchAllEntries } from '../lib/db';
import { deriveWritingActivityState } from '../domain/writing/entry-status';
import { getTodaySP, getSpYear, getSpMonth } from '../lib/timezone';
import type { ObligatoryCompletion, ObligatoryFeatures } from './celebration-types';

/** Which obligatory activities to actually query (skip the just-finished one). */
export interface CompletionQueryPlan {
  writing: boolean;
  pronunciation: boolean;
  listening: boolean;
}

async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

async function isWritingCompletedToday(today: string): Promise<boolean> {
  const entries = await fetchAllEntries();
  const entry = entries[today];
  const state = deriveWritingActivityState({
    storedStatus: entry?.status ?? null,
    hasText: !!entry?.originalText?.trim(),
    hasReview: entry?.status === 'corrigido' || entry?.status === 'revisado',
    hasFinalVersion: entry?.status === 'revisado',
  });
  return state === 'completed';
}

async function isPronunciationCompletedToday(today: string): Promise<boolean> {
  const dates = await getPronunciationDatesForMonth(getSpYear(), getSpMonth());
  return dates.has(today);
}

async function isListeningCompletedToday(today: string): Promise<boolean> {
  const map = await getListeningDatesForMonth(getSpYear(), getSpMonth());
  return map[today] === 'completed';
}

/**
 * Fetch completed-today for exactly the activities named in `plan`. Anything not
 * requested (or that errors) comes back `false`.
 */
export async function fetchObligatoryCompletion(
  plan: CompletionQueryPlan,
): Promise<ObligatoryCompletion> {
  const today = getTodaySP();

  const [writing, pronunciation, listening] = await Promise.all([
    plan.writing ? safe(isWritingCompletedToday(today), false) : Promise.resolve(false),
    plan.pronunciation
      ? safe(isPronunciationCompletedToday(today), false)
      : Promise.resolve(false),
    plan.listening ? safe(isListeningCompletedToday(today), false) : Promise.resolve(false),
  ]);

  return { writing, pronunciation, listening };
}

/**
 * Build the query plan: we only need the OTHER enabled obligatory activities,
 * because the just-finished one is already known completed.
 */
export function buildQueryPlan(
  features: ObligatoryFeatures,
  justFinished: 'writing' | 'pronunciation' | 'listening',
): CompletionQueryPlan {
  return {
    writing: features.writing && justFinished !== 'writing',
    pronunciation: features.pronunciation && justFinished !== 'pronunciation',
    listening: features.listening && justFinished !== 'listening',
  };
}
