import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────
// Supabase RPC gateway (the server-authoritative claim/gate layer).
const mockRpc = vi.fn();
vi.mock('../supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
}));

// The native AppsFlyer wrapper. We assert on what the orchestration decides to
// log — the actual native bridge is exercised by appsFlyerClient.*.test.ts.
const mockLogEvent = vi.fn();
const mockSupported = vi.fn();
const mockSetCUID = vi.fn();
vi.mock('./appsFlyerClient', () => ({
  isAppsFlyerSupported: () => mockSupported(),
  logAppsFlyerEvent: (...args: unknown[]) => mockLogEvent(...args),
  setAppsFlyerCustomerUserId: (...args: unknown[]) => mockSetCUID(...args),
}));

// Pretend we're on native Android (drives store = play_store for checkout).
vi.mock('../runtimeEnvironment', () => ({ isIOSApp: false, isAndroidApp: true }));

import {
  trackRegistrationCompleted,
  trackActivityCompleted,
  trackPaywallViewed,
  trackCheckoutStarted,
  resetAppsFlyerMarketingCache,
  syncAppsFlyerIdentityAndRegistration,
} from './appsFlyerEvents';

const ok = (data: unknown) => ({ data, error: null });
const rpcErr = () => ({ data: null, error: { message: 'boom' } });

beforeEach(() => {
  vi.clearAllMocks();
  resetAppsFlyerMarketingCache();
  mockSupported.mockReturnValue(true); // native by default
  mockLogEvent.mockResolvedValue(true);
  mockSetCUID.mockResolvedValue(undefined);
});

describe('appsFlyerEvents — web / unsupported (1)', () => {
  it('does nothing on web: no RPC, no logEvent', async () => {
    mockSupported.mockReturnValue(false);
    await trackRegistrationCompleted();
    await trackActivityCompleted('writing');
    await trackPaywallViewed('gate');
    await trackCheckoutStarted('plus');
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogEvent).not.toHaveBeenCalled();
  });
});

describe('af_complete_registration (2,3)', () => {
  it('fires once when the server authorizes a new registration', async () => {
    mockRpc.mockResolvedValue(ok(true));
    await trackRegistrationCompleted();
    expect(mockRpc).toHaveBeenCalledWith('claim_appsflyer_registration');
    expect(mockLogEvent).toHaveBeenCalledTimes(1);
    expect(mockLogEvent).toHaveBeenCalledWith('af_complete_registration');
  });

  it('does not fire on a later login / session restore (server returns false)', async () => {
    mockRpc.mockResolvedValue(ok(false));
    await trackRegistrationCompleted();
    expect(mockLogEvent).not.toHaveBeenCalled();
  });
});

describe('first_activity_completed + learning_day_completed (4-9)', () => {
  it('first activity ever → both events, with activity_type + days_since_registration (4)', async () => {
    mockRpc.mockResolvedValue(ok([{ first_activity: true, learning_day: true, days_since_registration: 0 }]));
    await trackActivityCompleted('writing');
    expect(mockRpc).toHaveBeenCalledWith('claim_appsflyer_activity_events', { p_activity_type: 'writing' });
    expect(mockLogEvent).toHaveBeenCalledWith('first_activity_completed', { activity_type: 'writing' });
    expect(mockLogEvent).toHaveBeenCalledWith('learning_day_completed', {
      activity_type: 'writing',
      days_since_registration: 0,
    });
  });

  it('second activity of the LIFE → neither repeats (5)', async () => {
    mockRpc.mockResolvedValue(ok([{ first_activity: false, learning_day: false, days_since_registration: 3 }]));
    await trackActivityCompleted('pronunciation');
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it('first activity of a NEW day → only learning_day (6)', async () => {
    mockRpc.mockResolvedValue(ok([{ first_activity: false, learning_day: true, days_since_registration: 5 }]));
    await trackActivityCompleted('listening');
    expect(mockLogEvent).toHaveBeenCalledTimes(1);
    expect(mockLogEvent).toHaveBeenCalledWith('learning_day_completed', {
      activity_type: 'listening',
      days_since_registration: 5,
    });
  });

  it('another activity the SAME day → nothing (7)', async () => {
    mockRpc.mockResolvedValue(ok([{ first_activity: false, learning_day: false }]));
    await trackActivityCompleted('review');
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it('omits days_since_registration when the server could not compute it', async () => {
    mockRpc.mockResolvedValue(ok([{ first_activity: false, learning_day: true, days_since_registration: null }]));
    await trackActivityCompleted('conversation');
    expect(mockLogEvent).toHaveBeenCalledWith('learning_day_completed', { activity_type: 'conversation' });
  });

  it('double call → fires only what the (idempotent) server authorizes (9)', async () => {
    mockRpc
      .mockResolvedValueOnce(ok([{ first_activity: true, learning_day: true, days_since_registration: 0 }]))
      .mockResolvedValueOnce(ok([{ first_activity: false, learning_day: false, days_since_registration: 0 }]));
    await Promise.all([trackActivityCompleted('writing'), trackActivityCompleted('writing')]);
    const names = mockLogEvent.mock.calls.map((c) => c[0]);
    expect(names.filter((n) => n === 'first_activity_completed')).toHaveLength(1);
    expect(names.filter((n) => n === 'learning_day_completed')).toHaveLength(1);
  });
});

describe('ever-paid stop rule (10,11,12)', () => {
  it('paid user → activity events suppressed server-side (10,11)', async () => {
    // Server RPC returns both false regardless of first/day for a paid user.
    mockRpc.mockResolvedValue(ok([{ first_activity: false, learning_day: false }]));
    await trackActivityCompleted('writing');
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it('paid user → paywall/checkout suppressed by the gate (10,11)', async () => {
    mockRpc.mockImplementation((fn: string) =>
      fn === 'appsflyer_marketing_allowed' ? Promise.resolve(ok(false)) : Promise.resolve(ok(null)),
    );
    await trackPaywallViewed('gate');
    await trackCheckoutStarted('plus');
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it('free-trial user who NEVER paid → still eligible (12)', async () => {
    mockRpc.mockImplementation((fn: string) =>
      fn === 'appsflyer_marketing_allowed' ? Promise.resolve(ok(true)) : Promise.resolve(ok(null)),
    );
    await trackPaywallViewed('gate');
    expect(mockLogEvent).toHaveBeenCalledWith('paywall_viewed', { source: 'gate' });
  });

  it('gate is sticky: once blocked, no further RPC round-trips', async () => {
    mockRpc.mockResolvedValue(ok(false));
    await trackPaywallViewed();
    await trackCheckoutStarted('essential');
    // Exactly one gate call — the cached false short-circuits the second.
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });
});

describe('paywall_viewed & af_initiated_checkout (13,14)', () => {
  it('paywall_viewed fires with source when allowed (13)', async () => {
    mockRpc.mockResolvedValue(ok(true));
    await trackPaywallViewed('conversation_limit');
    expect(mockLogEvent).toHaveBeenCalledWith('paywall_viewed', { source: 'conversation_limit' });
  });

  it('af_initiated_checkout carries plan + store (14)', async () => {
    mockRpc.mockResolvedValue(ok(true));
    await trackCheckoutStarted('plus');
    expect(mockLogEvent).toHaveBeenCalledWith('af_initiated_checkout', { plan: 'plus', store: 'play_store' });
  });
});

describe('fail-safe & no client-side purchase (15,16)', () => {
  it('an RPC failure never throws and logs nothing (15)', async () => {
    mockRpc.mockRejectedValue(new Error('network'));
    await expect(trackActivityCompleted('writing')).resolves.toBeUndefined();
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it('a logEvent failure never throws (15)', async () => {
    mockRpc.mockResolvedValue(ok(true));
    mockLogEvent.mockRejectedValue(new Error('bridge'));
    await expect(trackRegistrationCompleted()).resolves.toBeUndefined();
  });

  it('never emits af_purchase / revenue from the client (16)', async () => {
    mockRpc.mockResolvedValue(ok([{ first_activity: true, learning_day: true, days_since_registration: 1 }]));
    await trackRegistrationCompleted();
    await trackActivityCompleted('writing');
    mockRpc.mockResolvedValue(ok(true));
    await trackPaywallViewed('x');
    await trackCheckoutStarted('plus');
    const names = mockLogEvent.mock.calls.map((c) => c[0]);
    expect(names).not.toContain('af_purchase');
    expect(names.every((n) => [
      'af_complete_registration',
      'first_activity_completed',
      'learning_day_completed',
      'paywall_viewed',
      'af_initiated_checkout',
    ].includes(n))).toBe(true);
  });
});

describe('CUID is set before af_complete_registration (order regression)', () => {
  it('setCustomerUserId resolves BEFORE the registration event fires', async () => {
    const order: string[] = [];
    // CUID set completes on a later microtask — a racy (non-awaited) impl would
    // let the registration log slip in first.
    mockSetCUID.mockImplementation(async () => {
      await Promise.resolve();
      order.push('cuid');
    });
    mockLogEvent.mockImplementation(async () => {
      order.push('log');
      return true;
    });
    mockRpc.mockResolvedValue(ok(true)); // claim true, mark ok
    await syncAppsFlyerIdentityAndRegistration('aaaaaaaa-0000-0000-0000-000000000001');
    expect(order).toEqual(['cuid', 'log']);
    expect(mockLogEvent).toHaveBeenCalledWith('af_complete_registration');
  });

  it('sign-out (null) sets no CUID event and fires no registration', async () => {
    await syncAppsFlyerIdentityAndRegistration(null);
    expect(mockSetCUID).toHaveBeenCalledWith(null);
    expect(mockLogEvent).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('delivery state — claim must not be consumed if AppsFlyer fails (2,6)', () => {
  it('native log FAILS after claim → NOT marked sent (stays retryable)', async () => {
    mockRpc.mockResolvedValue(ok(true));
    mockLogEvent.mockResolvedValue(false); // delivery failed
    await trackRegistrationCompleted();
    expect(mockRpc).toHaveBeenCalledWith('claim_appsflyer_registration');
    expect(mockRpc).not.toHaveBeenCalledWith('mark_appsflyer_event_sent', expect.anything());
  });

  it('native log SUCCEEDS → marked sent', async () => {
    mockRpc.mockResolvedValue(ok(true));
    mockLogEvent.mockResolvedValue(true);
    await trackRegistrationCompleted();
    expect(mockRpc).toHaveBeenCalledWith('mark_appsflyer_event_sent', { p_event_key: 'registration' });
  });

  it('retry after a failed delivery: later claim re-authorizes, then marks sent', async () => {
    mockRpc.mockResolvedValue(ok(true)); // server re-authorizes the still-pending slot
    mockLogEvent.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await trackRegistrationCompleted(); // fails → no mark
    expect(mockRpc).not.toHaveBeenCalledWith('mark_appsflyer_event_sent', expect.anything());
    await trackRegistrationCompleted(); // succeeds → mark
    expect(mockRpc).toHaveBeenCalledWith('mark_appsflyer_event_sent', { p_event_key: 'registration' });
  });

  it('activity: log failure leaves first_activity retryable; success marks it sent', async () => {
    mockRpc.mockResolvedValue(ok([{ first_activity: true, learning_day: false, days_since_registration: 0 }]));
    mockLogEvent.mockResolvedValueOnce(false); // first_activity delivery fails
    await trackActivityCompleted('writing');
    expect(mockRpc).not.toHaveBeenCalledWith('mark_appsflyer_event_sent', { p_event_key: 'first_activity' });

    mockLogEvent.mockResolvedValue(true);
    await trackActivityCompleted('writing');
    expect(mockRpc).toHaveBeenCalledWith('mark_appsflyer_event_sent', { p_event_key: 'first_activity' });
  });

  it('concurrency: a delivered event is not duplicated (server authorizes once)', async () => {
    // The DB claim de-dupes: only the first concurrent claim is authorized.
    let claimCall = 0;
    mockRpc.mockImplementation((fn: string) => {
      if (fn === 'claim_appsflyer_activity_events') {
        claimCall += 1;
        return Promise.resolve(ok([
          claimCall === 1
            ? { first_activity: true, learning_day: true, days_since_registration: 0 }
            : { first_activity: false, learning_day: false, days_since_registration: 0 },
        ]));
      }
      return Promise.resolve(ok(true)); // mark_appsflyer_event_sent
    });
    await Promise.all([trackActivityCompleted('writing'), trackActivityCompleted('writing')]);
    const fired = mockLogEvent.mock.calls.map((c) => c[0]);
    expect(fired.filter((n) => n === 'first_activity_completed')).toHaveLength(1);
    expect(fired.filter((n) => n === 'learning_day_completed')).toHaveLength(1);
  });
});

describe('ever-paid gate is FAIL-CLOSED (3,6)', () => {
  it('gate RPC error → paywall_viewed NOT sent', async () => {
    mockRpc.mockResolvedValue(rpcErr());
    await trackPaywallViewed('gate');
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it('gate RPC error → af_initiated_checkout NOT sent', async () => {
    mockRpc.mockResolvedValue(rpcErr());
    await trackCheckoutStarted('plus');
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it('gate RPC throws → nothing sent', async () => {
    mockRpc.mockRejectedValue(new Error('network'));
    await trackPaywallViewed('gate');
    await trackCheckoutStarted('essential');
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it('ever-paid user stays blocked across calls (10,11)', async () => {
    mockRpc.mockResolvedValue(ok(false)); // definitive: not allowed
    await trackPaywallViewed();
    await trackCheckoutStarted('plus');
    expect(mockLogEvent).not.toHaveBeenCalled();
  });
});
