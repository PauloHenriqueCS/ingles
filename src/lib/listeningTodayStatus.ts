import type { TodayListeningResult } from './listeningApi';

/**
 * Every `status` value GET /api/listening/today can currently return.
 * Kept in sync with TodayListeningResult in listeningApi.ts by hand — this
 * is deliberately a plain runtime list (not derived from the TS union),
 * since the whole point is to guard against a *runtime* mismatch between
 * what an already-loaded frontend bundle expects and what the (possibly
 * newer) deployed backend actually sends.
 */
const KNOWN_TODAY_LISTENING_STATUSES = new Set([
  'assigned',
  'in_progress',
  'completed',
  'empty_inventory',
  'story_completed',
  'group_generating',
]);

/**
 * Guards against a version-skew crash: if a browser has an older cached JS
 * bundle (predating a backend response-shape change, e.g. the
 * 'group_generating' status added for shared level-group generation) and
 * the backend sends a status that bundle doesn't know about, blindly
 * falling through to `result.session.blocks.findIndex(...)` throws
 * "Cannot read properties of undefined" — an uncaught TypeError, not a
 * ListeningApiError, which callers then report as an opaque generic
 * message with no indication of what actually went wrong.
 */
export function isRecognizedTodayListeningStatus(
  result: unknown,
): result is TodayListeningResult {
  return (
    typeof result === 'object' &&
    result !== null &&
    'status' in result &&
    typeof (result as { status: unknown }).status === 'string' &&
    KNOWN_TODAY_LISTENING_STATUSES.has((result as { status: string }).status)
  );
}
