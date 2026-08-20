/**
 * SERVER-ONLY, dependency-free math for the per-session recording ceiling, so
 * it can be unit-tested without importing the heavy [...slug] handler. See
 * computeAuthorizedRecording in api/conversation/[...slug].ts for the wiring.
 *
 * The invariant this exists to protect: the per-session ceiling
 * (authorizedMaxRecordingSeconds) is the FIXED total budget for the call and
 * must NOT shrink merely because time passed between polls — otherwise a client
 * comparing its session-start-relative elapsed against a "remaining-from-this-
 * poll" number ends the recording at ~half the real balance. The fix is the
 * anchoring below: the per-turn cap (a fixed max call length) is anchored to
 * the session start, but the monthly/trial BALANCE — which is a remaining
 * measured from *now* and already folds in this session's own consumption — is
 * anchored to `now`, so `now + remaining` stays equal to `startedAt + initial`.
 * Underscore-prefixed so Vercel never treats it as a Serverless Function.
 */
export type RecordingLimitReason = 'per_turn' | 'monthly_balance' | 'trial_balance' | 'technical';

export interface RecordingCeiling {
  authorizedMaxRecordingSeconds: number;
  recordingLimitReason: RecordingLimitReason;
  effectiveDeadlineMs: number;
}

export function computeRecordingCeiling(params: {
  startedAtMs: number;
  /** Real clock at the moment of this computation (session start OR a poll). */
  nowMs: number;
  technicalDeadlineMs: number;
  /** Per-call max length in seconds (Infinity when unlimited). */
  perTurnCapSeconds: number;
  /** Remaining monthly/trial balance in seconds, measured from now (Infinity when unlimited). */
  monthlyRemainingSeconds: number;
  /** true when the balance is the trial's lifetime total (period === 'lifetime'). */
  isLifetimeTrial: boolean;
}): RecordingCeiling {
  const { startedAtMs, nowMs, technicalDeadlineMs, perTurnCapSeconds, monthlyRemainingSeconds, isLifetimeTrial } = params;

  // Fixed max call length from the session start — does NOT deplete.
  const perTurnDeadlineMs = Number.isFinite(perTurnCapSeconds) ? startedAtMs + perTurnCapSeconds * 1000 : Infinity;
  // Depleting balance measured from now — anchored to `now`, never to the past
  // start (that would double-subtract the elapsed and collapse the ceiling).
  const monthlyDeadlineMs = Number.isFinite(monthlyRemainingSeconds) ? nowMs + monthlyRemainingSeconds * 1000 : Infinity;

  const effectiveDeadlineMs = Math.min(technicalDeadlineMs, perTurnDeadlineMs, monthlyDeadlineMs);
  const authorizedMaxRecordingSeconds = Math.max(0, (effectiveDeadlineMs - startedAtMs) / 1000);

  let recordingLimitReason: RecordingLimitReason;
  if (effectiveDeadlineMs === perTurnDeadlineMs && Number.isFinite(perTurnDeadlineMs)) {
    recordingLimitReason = 'per_turn';
  } else if (effectiveDeadlineMs === monthlyDeadlineMs && Number.isFinite(monthlyDeadlineMs)) {
    recordingLimitReason = isLifetimeTrial ? 'trial_balance' : 'monthly_balance';
  } else {
    recordingLimitReason = 'technical';
  }

  return { authorizedMaxRecordingSeconds, recordingLimitReason, effectiveDeadlineMs };
}
