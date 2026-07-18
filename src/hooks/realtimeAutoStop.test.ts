import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { shouldAutoStopForCommercialLimit, pickStopMessage, pickStopEndReason, scheduleGracefulFinish } from './realtimeAutoStop';

describe('shouldAutoStopForCommercialLimit', () => {
  it('scenario 17: stops once elapsed reaches the per-turn authorized max', () => {
    expect(shouldAutoStopForCommercialLimit(18_000, 18, 'per_turn')).toBe(true);
    expect(shouldAutoStopForCommercialLimit(17_000, 18, 'per_turn')).toBe(false);
  });

  it('scenario 18: stops once elapsed reaches the remaining monthly balance, when it is smaller than the per-turn limit', () => {
    // authorizedMaxSeconds already reflects the smaller of the two (computed
    // server-side) — the hook only needs to compare elapsed against it.
    expect(shouldAutoStopForCommercialLimit(10_000, 10, 'monthly_balance')).toBe(true);
    expect(shouldAutoStopForCommercialLimit(9_000, 10, 'monthly_balance')).toBe(false);
  });

  it("scenario 21/25: never triggers for reason='technical' — the gateway backstop is not a commercial stop", () => {
    expect(shouldAutoStopForCommercialLimit(999_999, 5, 'technical')).toBe(false);
  });

  it('never triggers while authorizedMaxSeconds is still unknown (null) — e.g. right after connecting', () => {
    expect(shouldAutoStopForCommercialLimit(999_999, null, 'per_turn')).toBe(false);
  });

  it('never triggers when recordingLimitReason itself is unknown (null)', () => {
    expect(shouldAutoStopForCommercialLimit(999_999, 5, null)).toBe(false);
  });

  it('scenario 24: monthly unlimited + finite per-turn — governed by per_turn as reported by the backend', () => {
    // The backend already resolved which one binds; the frontend just acts on it.
    expect(shouldAutoStopForCommercialLimit(45_000, 45, 'per_turn')).toBe(true);
  });

  it('scenario 23: per-turn unlimited + finite monthly — governed by monthly_balance as reported by the backend', () => {
    expect(shouldAutoStopForCommercialLimit(20_000, 20, 'monthly_balance')).toBe(true);
  });
});

describe('pickStopMessage', () => {
  it("uses the balance-exhausted friendly message for reason='monthly_balance'", () => {
    expect(pickStopMessage('monthly_balance', 42)).toBe(
      'A gravação foi encerrada porque seus minutos disponíveis chegaram ao fim.',
    );
  });

  it("uses the per-turn limit message with the rounded elapsed seconds for reason='per_turn'", () => {
    expect(pickStopMessage('per_turn', 18.4)).toBe('A gravação foi encerrada ao atingir o limite de 18 segundos do seu plano.');
  });

  it('rounds fractional elapsed seconds rather than truncating or floating them raw into the message', () => {
    expect(pickStopMessage('per_turn', 29.6)).toContain('30 segundos');
  });
});

describe('pickStopEndReason', () => {
  it('maps monthly_balance to plan_monthly_balance_exhausted', () => {
    expect(pickStopEndReason('monthly_balance')).toBe('plan_monthly_balance_exhausted');
  });

  it('maps per_turn to plan_recording_limit_reached', () => {
    expect(pickStopEndReason('per_turn')).toBe('plan_recording_limit_reached');
  });
});

describe('scheduleGracefulFinish — scenario 26: never abruptly ends an in-progress AI reply', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('finishes almost immediately when no response is in flight', () => {
    const finish = vi.fn();
    scheduleGracefulFinish(() => false, finish);

    expect(finish).not.toHaveBeenCalled();
    vi.advanceTimersByTime(499);
    expect(finish).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it('waits for the in-flight response to finish before calling finish — the conversation is not cut off mid-reply', () => {
    let responseActive = true;
    const finish = vi.fn();
    scheduleGracefulFinish(() => responseActive, finish, { pollMs: 100, timeoutMs: 5000 });

    vi.advanceTimersByTime(300);
    expect(finish).not.toHaveBeenCalled(); // still "speaking" — must not have been cut off

    responseActive = false; // response.done arrives
    vi.advanceTimersByTime(100);
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it('has a safety-net timeout so it never waits forever for a response.done that never arrives', () => {
    const finish = vi.fn();
    scheduleGracefulFinish(() => true, finish, { pollMs: 100, timeoutMs: 2000 });

    vi.advanceTimersByTime(1999);
    expect(finish).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it('never calls finish twice, even if the poll and the safety timeout race', () => {
    let responseActive = true;
    const finish = vi.fn();
    scheduleGracefulFinish(() => responseActive, finish, { pollMs: 500, timeoutMs: 500 });

    responseActive = false;
    vi.advanceTimersByTime(600); // both the poll tick and the safety timeout have now elapsed
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it('the returned cancel function stops any further finish call', () => {
    const finish = vi.fn();
    const cancel = scheduleGracefulFinish(() => true, finish, { pollMs: 100, timeoutMs: 2000 });

    cancel();
    vi.advanceTimersByTime(3000);
    expect(finish).not.toHaveBeenCalled();
  });
});
