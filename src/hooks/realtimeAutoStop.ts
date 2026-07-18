import type { RecordingLimitReason } from '../lib/realtimeGatewayReporting';
import { ENTITLEMENT_MESSAGES } from '../domain/entitlements/entitlement-messages';

/**
 * Pure decision logic for useRealtimeSession.ts's Fase 12 auto-stop —
 * extracted so it can be unit-tested without mocking RTCPeerConnection/
 * MediaStream. 'technical' is deliberately never a stop trigger here: when
 * both commercial values are unlimited, only the pre-existing pure
 * technical ceiling (maxSessionMsRef) applies, and it must never be
 * presented to the user as a commercial limit.
 */
export function shouldAutoStopForCommercialLimit(
  elapsedMs: number,
  authorizedMaxSeconds: number | null,
  recordingLimitReason: RecordingLimitReason | null,
): boolean {
  if (authorizedMaxSeconds === null) return false;
  if (recordingLimitReason !== 'per_turn' && recordingLimitReason !== 'monthly_balance') return false;
  return elapsedMs / 1000 >= authorizedMaxSeconds;
}

/** The friendly message shown when triggerLimitStop fires — differentiates per-turn vs balance-exhausted, per the product spec. */
export function pickStopMessage(limitReason: 'per_turn' | 'monthly_balance', elapsedSeconds: number): string {
  return limitReason === 'monthly_balance'
    ? ENTITLEMENT_MESSAGES.conversationRecordingStoppedByBalance
    : ENTITLEMENT_MESSAGES.recordingLimitReached(Math.round(elapsedSeconds));
}

/** The session-end reason reported to the backend for each commercial stop trigger. */
export function pickStopEndReason(limitReason: 'per_turn' | 'monthly_balance'): string {
  return limitReason === 'monthly_balance' ? 'plan_monthly_balance_exhausted' : 'plan_recording_limit_reached';
}

/**
 * Never abruptly ends the conversation: if the AI is mid-response when the
 * limit hits, waits for it to finish (response.done) before actually
 * closing, so the student never hears a reply cut off mid-sentence. Falls
 * back to a safety-net timeout in case response.done never arrives.
 * Returns a cleanup function the caller must invoke if the component/hook
 * unmounts or ends for another reason before this resolves, to avoid a
 * stray timer firing `finish` twice.
 */
export function scheduleGracefulFinish(
  isResponseActive: () => boolean,
  finish: () => void,
  opts: { pollMs?: number; timeoutMs?: number } = {},
): () => void {
  const pollMs = opts.pollMs ?? 250;
  const timeoutMs = opts.timeoutMs ?? 8000;

  if (!isResponseActive()) {
    const t = setTimeout(finish, 500);
    return () => clearTimeout(t);
  }

  let done = false;
  const poll = setInterval(() => {
    if (done) return;
    if (!isResponseActive()) {
      done = true;
      clearInterval(poll);
      clearTimeout(safety);
      finish();
    }
  }, pollMs);
  const safety = setTimeout(() => {
    if (done) return;
    done = true;
    clearInterval(poll);
    finish();
  }, timeoutMs);

  return () => { done = true; clearInterval(poll); clearTimeout(safety); };
}
