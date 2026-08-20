/**
 * The per-session recording ceiling must stay FIXED across polls. Regression for
 * the live bug where a 2-min balance ended at ~1 min: handleSessionControl
 * recomputed the ceiling every poll from the *depleting* monthly balance while
 * anchoring it to the past session start, so the deadline collapsed to
 * startedAt + (R - elapsed) and both the displayed "/ 00:59" ceiling and the
 * server termination fired at elapsed ≈ R/2. Anchoring the balance to `now`
 * keeps the absolute deadline at startedAt + R.
 */
import { describe, it, expect } from 'vitest';
import { computeRecordingCeiling } from '../conversation/_recording-ceiling';

const T0 = 1_000_000_000_000; // session start ms
const R = 120;                // 2-min initial balance (seconds)
const TECH_FAR = T0 + 60 * 60 * 1000; // technical cap far in the future

// Balance is a remaining-from-now: at `elapsed` seconds in, remaining = R - elapsed.
function ceilingAtPoll(elapsedSec: number, remainingSec = R - elapsedSec) {
  return computeRecordingCeiling({
    startedAtMs: T0,
    nowMs: T0 + elapsedSec * 1000,
    technicalDeadlineMs: TECH_FAR,
    perTurnCapSeconds: Infinity,
    monthlyRemainingSeconds: remainingSec,
    isLifetimeTrial: true,
  });
}

describe('computeRecordingCeiling — fixed ceiling across polls', () => {
  it('at session start the ceiling equals the initial balance', () => {
    const c = ceilingAtPoll(0);
    expect(c.authorizedMaxRecordingSeconds).toBe(120);
    expect(c.effectiveDeadlineMs).toBe(T0 + 120_000);
    expect(c.recordingLimitReason).toBe('trial_balance');
  });

  it('stays FIXED at 120s on later polls — never shrinks to the remaining (the bug)', () => {
    // Exactly the two screenshots: elapsed 32s (was showing /01:24) and 58s
    // (was showing /00:59). Both must report the SAME 120s ceiling / deadline.
    const a = ceilingAtPoll(32); // remaining 88
    const b = ceilingAtPoll(58); // remaining 62
    expect(a.authorizedMaxRecordingSeconds).toBe(120);
    expect(b.authorizedMaxRecordingSeconds).toBe(120);
    expect(a.effectiveDeadlineMs).toBe(T0 + 120_000);
    expect(b.effectiveDeadlineMs).toBe(T0 + 120_000);
    // The old bug would have surfaced the remaining as the ceiling.
    expect(b.authorizedMaxRecordingSeconds).not.toBe(62);
  });

  it('server terminates at the REAL zero (elapsed = R), not at half the balance', () => {
    // terminate when now >= effectiveDeadlineMs
    const atHalf = ceilingAtPoll(60); // remaining 60
    expect(T0 + 60_000 >= atHalf.effectiveDeadlineMs).toBe(false); // still running at 1 min
    const atEnd = ceilingAtPoll(120, 0); // remaining 0
    expect(T0 + 120_000 >= atEnd.effectiveDeadlineMs).toBe(true);  // ends exactly at 2 min
  });

  it('paid plan reports monthly_balance; the ceiling math is identical', () => {
    const c = computeRecordingCeiling({
      startedAtMs: T0, nowMs: T0 + 40_000, technicalDeadlineMs: TECH_FAR,
      perTurnCapSeconds: Infinity, monthlyRemainingSeconds: 80, isLifetimeTrial: false,
    });
    expect(c.authorizedMaxRecordingSeconds).toBe(120); // 40 elapsed + 80 remaining
    expect(c.recordingLimitReason).toBe('monthly_balance');
  });
});

describe('computeRecordingCeiling — other constraints unchanged', () => {
  it('a per-turn cap is a fixed max call length anchored to the START (does not deplete)', () => {
    const early = computeRecordingCeiling({ startedAtMs: T0, nowMs: T0, technicalDeadlineMs: TECH_FAR, perTurnCapSeconds: 300, monthlyRemainingSeconds: Infinity, isLifetimeTrial: false });
    const later = computeRecordingCeiling({ startedAtMs: T0, nowMs: T0 + 100_000, technicalDeadlineMs: TECH_FAR, perTurnCapSeconds: 300, monthlyRemainingSeconds: Infinity, isLifetimeTrial: false });
    expect(early.effectiveDeadlineMs).toBe(T0 + 300_000);
    expect(later.effectiveDeadlineMs).toBe(T0 + 300_000); // same absolute deadline
    expect(early.recordingLimitReason).toBe('per_turn');
  });

  it('fully unlimited → governed by the technical ceiling', () => {
    const c = computeRecordingCeiling({ startedAtMs: T0, nowMs: T0 + 5_000, technicalDeadlineMs: TECH_FAR, perTurnCapSeconds: Infinity, monthlyRemainingSeconds: Infinity, isLifetimeTrial: false });
    expect(c.effectiveDeadlineMs).toBe(TECH_FAR);
    expect(c.recordingLimitReason).toBe('technical');
  });

  it('the smaller of per-turn cap and balance wins', () => {
    // remaining 200 (deadline T0+205s at 5s in) vs per-turn 60 (deadline T0+60s) → per-turn wins
    const c = computeRecordingCeiling({ startedAtMs: T0, nowMs: T0 + 5_000, technicalDeadlineMs: TECH_FAR, perTurnCapSeconds: 60, monthlyRemainingSeconds: 200, isLifetimeTrial: false });
    expect(c.effectiveDeadlineMs).toBe(T0 + 60_000);
    expect(c.recordingLimitReason).toBe('per_turn');
  });
});
