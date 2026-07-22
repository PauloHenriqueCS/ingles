import { describe, it, expect } from 'vitest';
import { isRecognizedTodayListeningStatus } from './listeningTodayStatus';

describe('isRecognizedTodayListeningStatus', () => {
  it('accepts every currently-known /api/listening/today status', () => {
    for (const status of [
      'assigned', 'in_progress', 'completed',
      'empty_inventory', 'story_completed', 'group_generating',
    ]) {
      expect(isRecognizedTodayListeningStatus({ status })).toBe(true);
    }
  });

  it('reproduces the reported bug: an unrecognized status (version-skew) is rejected, not blindly accepted', () => {
    // Exactly the failure mode: an old cached frontend bundle predating a
    // backend response-shape change (e.g. the 'group_generating' status)
    // receives a status it has never heard of. Before this fix,
    // loadTodaySession() fell through to `result.session.blocks.findIndex`
    // on a response with no `session` field at all, throwing an uncaught
    // TypeError that surfaced to the user as the opaque
    // "Erro ao carregar listening do dia." with zero diagnostic value.
    const futureShapeResponse = {
      status: 'some_future_status_this_bundle_has_never_heard_of',
      groupJob: { jobId: 'x' },
    };
    expect(isRecognizedTodayListeningStatus(futureShapeResponse)).toBe(false);
  });

  it('rejects a response with no status field at all', () => {
    expect(isRecognizedTodayListeningStatus({})).toBe(false);
  });

  it('rejects null, undefined, and non-object values', () => {
    expect(isRecognizedTodayListeningStatus(null)).toBe(false);
    expect(isRecognizedTodayListeningStatus(undefined)).toBe(false);
    expect(isRecognizedTodayListeningStatus('assigned')).toBe(false);
    expect(isRecognizedTodayListeningStatus(42)).toBe(false);
  });

  it('rejects a status field that is not a string', () => {
    expect(isRecognizedTodayListeningStatus({ status: 200 })).toBe(false);
    expect(isRecognizedTodayListeningStatus({ status: null })).toBe(false);
  });
});
