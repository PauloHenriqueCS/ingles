/**
 * Integration tests for api/pronunciation-training/[...slug].ts (token) —
 * AI Gateway integration (Etapa 9), featureKey pronunciation.get_azure_token,
 * PLUS the individual-word training gate (8s / 3-attempts-per-word).
 *
 * This endpoint serves ONLY the individual-word drill, so every call carries
 * { word, ownerType, ownerId } and consumes one server-counted attempt via the
 * register_word_practice_attempt RPC before any token is issued.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockGatewayDeps } from './_ai-gateway-test-helpers';
import type { FeatureLimit, PlanEntitlementsSnapshot } from '../../src/domain/entitlements/entitlement-types';
import { WORD_PRACTICE_MAX_ATTEMPTS } from '../../src/domain/pronunciation/word-practice-limits';

const { mockIssueToken, mockRequireAuth, mockGetCurrentUserPlanEntitlements, mockRpc, mockServiceRpc, gw } = vi.hoisted(() => {
  const mockIssueToken = vi.fn();
  const mockRequireAuth = vi.fn();
  const mockGetCurrentUserPlanEntitlements = vi.fn();
  const mockRpc = vi.fn();          // auth.supabase.rpc — register_word_practice_attempt
  const mockServiceRpc = vi.fn();   // service-role client — release_word_practice_attempt (refund)
  return { mockIssueToken, mockRequireAuth, mockGetCurrentUserPlanEntitlements, mockRpc, mockServiceRpc, gw: {} as ReturnType<typeof import('./_ai-gateway-test-helpers').createMockGatewayDeps> };
});

vi.mock('../_ai-gateway/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_ai-gateway/index')>();
  return {
    ...actual,
    getProductionDeps: () => gw.mockDeps,
    // Refund path uses the service-role client, never the user client.
    getSharedServiceClient: () => ({ rpc: mockServiceRpc }),
  };
});

vi.mock('../_azure-speech', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_azure-speech')>();
  return { ...actual, issueAzureSpeechToken: mockIssueToken };
});

// Rate limiting is orthogonal here (covered by its own tests). The
// 'pronunciation-training-token' key is failClosed, so the real applyRateLimit
// would 503 in the no-service-key test env before the gateway/token path.
vi.mock('../_rateLimit', () => ({ applyRateLimit: vi.fn().mockResolvedValue(true), RATE_LIMITS: {} }));
vi.mock('../_auth', () => ({ requireAuth: mockRequireAuth }));
vi.mock('openai', () => ({ default: vi.fn() }));
vi.mock('../_entitlements/plan-entitlements-service', () => ({
  getCurrentUserPlanEntitlements: mockGetCurrentUserPlanEntitlements,
}));

import handler from '../pronunciation-training/[...slug]';
import { AzureSpeechError } from '../_azure-speech';

const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000011';
const SESSION_ID = 'bbbbbbbb-0000-0000-0000-000000000022';

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    url: '/api/pronunciation-training/token',
    headers: { authorization: 'Bearer test-token' },
    body: { word: 'chocolate', ownerType: 'training', ownerId: SESSION_ID },
    ...overrides,
  };
}

function makeRes() {
  let _status = 200;
  let _body: unknown;
  const res = {
    _status: () => _status,
    _body: () => _body,
    status(s: number) { _status = s; return res; },
    json(b: unknown) { _body = b; return res; },
    setHeader: vi.fn(),
  };
  return res;
}

function permissiveLimit(period: 'day' | 'month' | 'request' | 'none' = 'day'): FeatureLimit {
  return { enabled: true, unlimited: true, limit: 0, consumed: 0, remaining: Number.POSITIVE_INFINITY, period, state: 'unlimited', canStart: true };
}

function permissiveEntitlements(): PlanEntitlementsSnapshot {
  return {
    planId: 'plan-1', planCode: 'free', planName: 'Gratuito', planVersionId: 'version-1', suspended: false,
    writing: { enabled: true, themeGenerations: permissiveLimit('day'), reviews: permissiveLimit('day'), maxCharactersPerText: 0, maxCharactersUnlimited: true },
    listening: { enabled: true, stories: permissiveLimit('day') },
    pronunciation: { enabled: true, evaluations: permissiveLimit('day'), maxRecordingSeconds: 0, maxRecordingUnlimited: true },
    conversation: { enabled: true, monthlyTime: permissiveLimit('month'), maxRecordingSeconds: 0, maxRecordingUnlimited: true, extraPurchaseEnabled: false, extraSecondsAvailable: 0 },
    monthlyRenewsAt: null,
    resolvedAt: new Date().toISOString(),
  };
}

/**
 * Stateful stand-in for the register_word_practice_attempt SQL RPC — mirrors
 * its exact contract: per (owner_type, owner_id, normalized-word) counter,
 * capped at p_max_attempts, atomic-increment-then-check semantics. Lets the
 * handler tests prove the end-to-end gate (accept 1..3, block 4th, per-word
 * isolation, ownership) without a live database.
 */
function makeWordAttemptRpc(ownedIds: Set<string> = new Set([SESSION_ID])) {
  const counts = new Map<string, number>();
  const normalize = (w: string) => w.toLowerCase().replace(/^[^a-z0-9]+/, '').replace(/[^a-z0-9]+$/, '').trim();
  return vi.fn(async (fn: string, params: Record<string, unknown>) => {
    if (fn !== 'register_word_practice_attempt') return { data: null, error: null };
    const ownerType = params.p_owner_type as string;
    const ownerId = params.p_owner_id as string;
    const max = (params.p_max_attempts as number) ?? 3;
    if (!['training', 'writing'].includes(ownerType)) return { data: { error: 'INVALID_OWNER_TYPE' }, error: null };
    if (!ownedIds.has(ownerId)) return { data: { error: 'OWNER_NOT_FOUND' }, error: null };
    const word = normalize(String(params.p_word ?? ''));
    if (!word) return { data: { error: 'INVALID_WORD' }, error: null };
    const key = `${ownerType}:${ownerId}:${word}`;
    const current = counts.get(key) ?? 0;
    if (current >= max) return { data: { error: 'WORD_ATTEMPT_LIMIT_REACHED', attemptsUsed: max }, error: null };
    const next = current + 1;
    counts.set(key, next);
    return { data: { attemptsUsed: next }, error: null };
  });
}

/**
 * Shared stateful stand-in for BOTH SQL RPCs — register (increment, capped,
 * atomic) and release (decrement, floored at 0) mutate the same counter map,
 * so handler tests can prove a refund actually frees the slot and never goes
 * negative. `register` is wired to the user client (mockRpc); `release` to the
 * service-role client (mockServiceRpc).
 */
function makeWordAttemptStore(ownedIds: Set<string> = new Set([SESSION_ID]), max = WORD_PRACTICE_MAX_ATTEMPTS) {
  const counts = new Map<string, number>();
  const normalize = (w: unknown) => String(w ?? '').toLowerCase().replace(/^[^a-z0-9]+/, '').replace(/[^a-z0-9]+$/, '').trim();
  const keyOf = (p: Record<string, unknown>) => `${p.p_owner_type}:${p.p_owner_id}:${normalize(p.p_word)}`;
  const register = vi.fn(async (_fn: string, p: Record<string, unknown>) => {
    if (!['training', 'writing'].includes(p.p_owner_type as string)) return { data: { error: 'INVALID_OWNER_TYPE' }, error: null };
    if (!ownedIds.has(p.p_owner_id as string)) return { data: { error: 'OWNER_NOT_FOUND' }, error: null };
    if (!normalize(p.p_word)) return { data: { error: 'INVALID_WORD' }, error: null };
    const k = keyOf(p);
    const cur = counts.get(k) ?? 0;
    if (cur >= max) return { data: { error: 'WORD_ATTEMPT_LIMIT_REACHED', attemptsUsed: max }, error: null };
    counts.set(k, cur + 1);
    return { data: { attemptsUsed: cur + 1 }, error: null };
  });
  const release = vi.fn(async (_fn: string, p: Record<string, unknown>) => {
    const k = keyOf(p);
    const next = Math.max(0, (counts.get(k) ?? 0) - 1);
    counts.set(k, next);
    return { data: { attemptsUsed: next }, error: null };
  });
  return { counts, keyOf, register, release };
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(gw, createMockGatewayDeps());
  gw.resetDefaults();
  mockIssueToken.mockResolvedValue({ token: 'ephemeral-token-xyz', region: 'eastus', expiresInSeconds: 540 });
  mockRpc.mockResolvedValue({ data: { attemptsUsed: 1 }, error: null });
  mockServiceRpc.mockResolvedValue({ data: { attemptsUsed: 0 }, error: null });
  mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase: { rpc: mockRpc } });
  mockGetCurrentUserPlanEntitlements.mockResolvedValue(permissiveEntitlements());
});

describe('plan entitlements gate', () => {
  it('blocks with FEATURE_DISABLED when pronunciation.enabled is false, before issuing a token', async () => {
    const entitlements = permissiveEntitlements();
    entitlements.pronunciation.enabled = false;
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlements);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status()).toBe(403);
    expect((res._body() as any).code).toBe('FEATURE_DISABLED');
    expect(mockIssueToken).not.toHaveBeenCalled();
  });
});

describe('LEGACY mode', () => {
  it('returns the token and writes no telemetry', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
    expect((res._body() as any).token).toBe('ephemeral-token-xyz');
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
  });

  it('returns attempt metadata alongside the token', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    const body = res._body() as any;
    expect(body.attemptsUsed).toBe(1);
    expect(body.maxAttempts).toBe(WORD_PRACTICE_MAX_ATTEMPTS);
    expect(body.maxDurationSeconds).toBe(5);
  });
});

describe('OBSERVE mode', () => {
  beforeEach(() => {
    gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('records exactly one event, featureKey pronunciation.get_azure_token, provider azure, not billable', async () => {
    await handler(makeReq(), makeRes());
    expect(mockIssueToken).toHaveBeenCalledTimes(1);
    expect(gw.mockStartEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        featureKey: 'pronunciation.get_azure_token',
        provider: 'azure',
        service: 'speech_sts',
        userId: USER_ID,
        actorType: 'user',
        executionLocation: 'backend',
        attemptNumber: 1,
      }),
    );
    const metrics = gw.mockInsertMetrics.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(metrics).toEqual([expect.objectContaining({ metricKey: 'provider_requests', quantity: 1, isBillable: false })]);
  });

  it('never persists the token itself in metadata', async () => {
    await handler(makeReq(), makeRes());
    const startCall = gw.mockStartEvent.mock.calls[0][0] as any;
    expect(JSON.stringify(startCall.metadata)).not.toContain('ephemeral-token-xyz');
  });

  it('an Azure error creates a failed event and preserves the previous error mapping', async () => {
    mockIssueToken.mockRejectedValue(new AzureSpeechError('AZURE_SPEECH_TIMEOUT', 'timed out'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(gw.mockFailEvent).toHaveBeenCalledTimes(1);
    expect(res._status()).toBe(504);
    expect((res._body() as any).code).toBe('AZURE_SPEECH_TIMEOUT');
  });

  it('a telemetry failure does not prevent token issuance', async () => {
    gw.mockStartEvent.mockRejectedValue(new Error('DB down'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
    expect((res._body() as any).token).toBe('ephemeral-token-xyz');
  });
});

describe('individual-word attempt gate', () => {
  it('rejects a request with no word before touching the RPC or Azure', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { ownerType: 'training', ownerId: SESSION_ID } }), res);
    expect(res._status()).toBe(400);
    expect((res._body() as any).code).toBe('INVALID_WORD');
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockIssueToken).not.toHaveBeenCalled();
  });

  it('rejects an unknown ownerType', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { word: 'chocolate', ownerType: 'nope', ownerId: SESSION_ID } }), res);
    expect(res._status()).toBe(400);
    expect((res._body() as any).code).toBe('INVALID_OWNER_TYPE');
    expect(mockIssueToken).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid ownerId', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { word: 'chocolate', ownerType: 'training', ownerId: 'not-a-uuid' } }), res);
    expect(res._status()).toBe(400);
    expect((res._body() as any).code).toBe('INVALID_OWNER_ID');
    expect(mockIssueToken).not.toHaveBeenCalled();
  });

  it('passes the word/ownerType/ownerId and the 3-attempt cap to the RPC', async () => {
    await handler(makeReq(), makeRes());
    expect(mockRpc).toHaveBeenCalledWith('register_word_practice_attempt', {
      p_owner_type: 'training',
      p_owner_id: SESSION_ID,
      p_word: 'chocolate',
      p_max_attempts: WORD_PRACTICE_MAX_ATTEMPTS,
    });
  });

  it('OWNER_NOT_FOUND from the RPC → 404 and no token issued', async () => {
    mockRpc.mockResolvedValue({ data: { error: 'OWNER_NOT_FOUND' }, error: null });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(404);
    expect((res._body() as any).code).toBe('OWNER_NOT_FOUND');
    expect(mockIssueToken).not.toHaveBeenCalled();
  });

  it('accepts attempts 1..3 then blocks the 4th for the same word (no token on the 4th)', async () => {
    mockRpc.mockImplementation(makeWordAttemptRpc());

    for (let i = 1; i <= WORD_PRACTICE_MAX_ATTEMPTS; i++) {
      const res = makeRes();
      await handler(makeReq(), res);
      expect(res._status()).toBe(200);
      expect((res._body() as any).attemptsUsed).toBe(i);
    }
    expect(mockIssueToken).toHaveBeenCalledTimes(WORD_PRACTICE_MAX_ATTEMPTS);

    const blocked = makeRes();
    await handler(makeReq(), blocked);
    expect(blocked._status()).toBe(429);
    expect((blocked._body() as any).code).toBe('WORD_ATTEMPT_LIMIT_REACHED');
    // Still only 3 tokens ever issued — the 4th attempt got none.
    expect(mockIssueToken).toHaveBeenCalledTimes(WORD_PRACTICE_MAX_ATTEMPTS);
  });

  it('exhausting one word does NOT block a different word (per-word counting)', async () => {
    mockRpc.mockImplementation(makeWordAttemptRpc());

    for (let i = 0; i < WORD_PRACTICE_MAX_ATTEMPTS; i++) {
      await handler(makeReq({ body: { word: 'chocolate', ownerType: 'training', ownerId: SESSION_ID } }), makeRes());
    }
    const blockedChocolate = makeRes();
    await handler(makeReq({ body: { word: 'chocolate', ownerType: 'training', ownerId: SESSION_ID } }), blockedChocolate);
    expect(blockedChocolate._status()).toBe(429);

    // 'vanilla' still has all of its own attempts.
    const vanilla = makeRes();
    await handler(makeReq({ body: { word: 'vanilla', ownerType: 'training', ownerId: SESSION_ID } }), vanilla);
    expect(vanilla._status()).toBe(200);
    expect((vanilla._body() as any).attemptsUsed).toBe(1);
  });

  it('normalizes punctuation/case so "Chocolate," shares the same counter as "chocolate"', async () => {
    mockRpc.mockImplementation(makeWordAttemptRpc());
    const variants = ['chocolate', 'Chocolate,', ' CHOCOLATE '];
    for (let i = 0; i < variants.length; i++) {
      const res = makeRes();
      await handler(makeReq({ body: { word: variants[i], ownerType: 'training', ownerId: SESSION_ID } }), res);
      expect((res._body() as any).attemptsUsed).toBe(i + 1);
    }
    const blocked = makeRes();
    await handler(makeReq({ body: { word: 'chocolate', ownerType: 'training', ownerId: SESSION_ID } }), blocked);
    expect(blocked._status()).toBe(429);
  });
});

describe('server-side refund when token issuance fails', () => {
  const RELEASE_ARGS = {
    p_user_id: USER_ID,
    p_owner_type: 'training',
    p_owner_id: SESSION_ID,
    p_word: 'chocolate',
  };

  it('1. token emitted successfully → no refund, attempt stays consumed', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
    expect((res._body() as any).attemptsUsed).toBe(1);
    expect(mockServiceRpc).not.toHaveBeenCalled();
  });

  it('2. Azure 401 (AUTH_FAILED) → attempt refunded, original error surfaced', async () => {
    mockIssueToken.mockRejectedValue(new AzureSpeechError('AZURE_SPEECH_AUTH_FAILED', '401'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(503);
    expect((res._body() as any).code).toBe('AZURE_SPEECH_AUTH_FAILED');
    expect(mockServiceRpc).toHaveBeenCalledTimes(1);
    expect(mockServiceRpc).toHaveBeenCalledWith('release_word_practice_attempt', RELEASE_ARGS);
  });

  it('3. Azure 5xx (UNAVAILABLE) → attempt refunded', async () => {
    mockIssueToken.mockRejectedValue(new AzureSpeechError('AZURE_SPEECH_UNAVAILABLE', '500'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(503);
    expect(mockServiceRpc).toHaveBeenCalledWith('release_word_practice_attempt', RELEASE_ARGS);
  });

  it('4. Azure timeout → attempt refunded', async () => {
    mockIssueToken.mockRejectedValue(new AzureSpeechError('AZURE_SPEECH_TIMEOUT', 'timed out'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(504);
    expect(mockServiceRpc).toHaveBeenCalledWith('release_word_practice_attempt', RELEASE_ARGS);
  });

  it('4b. a non-Azure internal error during issuance still refunds', async () => {
    mockIssueToken.mockRejectedValue(new Error('boom'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(500);
    expect(mockServiceRpc).toHaveBeenCalledWith('release_word_practice_attempt', RELEASE_ARGS);
  });

  it('4c. a refund failure never masks the original token-issuance error', async () => {
    mockIssueToken.mockRejectedValue(new AzureSpeechError('AZURE_SPEECH_AUTH_FAILED', '401'));
    mockServiceRpc.mockRejectedValue(new Error('refund DB down'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(503);
    expect((res._body() as any).code).toBe('AZURE_SPEECH_AUTH_FAILED');
  });

  it('5. error BEFORE register (register RPC fails) → no refund, no token attempt', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'db down' } });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(500);
    expect(mockIssueToken).not.toHaveBeenCalled();
    expect(mockServiceRpc).not.toHaveBeenCalled();
  });

  it('5b. limit-reached / owner-not-found never refund (no increment happened)', async () => {
    mockRpc.mockResolvedValue({ data: { error: 'WORD_ATTEMPT_LIMIT_REACHED', attemptsUsed: 3 }, error: null });
    const limitRes = makeRes();
    await handler(makeReq(), limitRes);
    expect(limitRes._status()).toBe(429);
    expect(mockServiceRpc).not.toHaveBeenCalled();

    mockRpc.mockResolvedValue({ data: { error: 'OWNER_NOT_FOUND' }, error: null });
    const ownerRes = makeRes();
    await handler(makeReq(), ownerRes);
    expect(ownerRes._status()).toBe(404);
    expect(mockServiceRpc).not.toHaveBeenCalled();
  });

  it('6. the 4th attempt stays blocked (429) even with the refund path present', async () => {
    const store = makeWordAttemptStore();
    mockRpc.mockImplementation(store.register);
    mockServiceRpc.mockImplementation(store.release);

    for (let i = 0; i < WORD_PRACTICE_MAX_ATTEMPTS; i++) {
      const ok = makeRes();
      await handler(makeReq(), ok);
      expect(ok._status()).toBe(200);
    }
    const blocked = makeRes();
    await handler(makeReq(), blocked);
    expect(blocked._status()).toBe(429);
    // The blocked 4th never incremented, so it must never refund.
    expect(mockServiceRpc).not.toHaveBeenCalled();
  });

  it('7. a client-side failure AFTER a successful token is never part of the refund path', async () => {
    // Token issued OK → handler returns 200 and does not call release. Whatever
    // fails later in the browser (SDK/conversion/network/modal) is invisible to
    // the server and correctly cannot trigger a refund.
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
    expect(mockServiceRpc).not.toHaveBeenCalled();
  });

  it('8. refund frees exactly one slot and the counter never goes negative', async () => {
    const store = makeWordAttemptStore();
    mockRpc.mockImplementation(store.register);
    mockServiceRpc.mockImplementation(store.release);
    const body = { word: 'kiwi', ownerType: 'training', ownerId: SESSION_ID };
    const key = store.keyOf({ p_owner_type: 'training', p_owner_id: SESSION_ID, p_word: 'kiwi' });

    // One valid, consumed attempt.
    await handler(makeReq({ body }), makeRes());
    expect(store.counts.get(key)).toBe(1);

    // Ten failing issuances in a row: each registers then refunds → net 0,
    // and the count never dips below the one valid attempt (never negative).
    for (let i = 0; i < 10; i++) {
      mockIssueToken.mockRejectedValueOnce(new AzureSpeechError('AZURE_SPEECH_AUTH_FAILED', '401'));
      await handler(makeReq({ body }), makeRes());
      expect(store.counts.get(key)).toBe(1);
      expect(store.counts.get(key)!).toBeGreaterThanOrEqual(0);
    }

    // The one valid slot is still spendable up to the cap afterwards.
    await handler(makeReq({ body }), makeRes()); // 2
    await handler(makeReq({ body }), makeRes()); // 3
    const blocked = makeRes();
    await handler(makeReq({ body }), blocked);   // 4th blocked
    expect(blocked._status()).toBe(429);
    expect(store.counts.get(key)).toBe(3);
  });

  it('9. concurrent calls for the same word never exceed the cap (refund of a failed one frees a slot)', async () => {
    const store = makeWordAttemptStore();
    mockRpc.mockImplementation(store.register);
    mockServiceRpc.mockImplementation(store.release);
    const body = { word: 'grape', ownerType: 'training', ownerId: SESSION_ID };
    const key = store.keyOf({ p_owner_type: 'training', p_owner_id: SESSION_ID, p_word: 'grape' });

    // Five concurrent token requests, all issuances succeeding: the atomic
    // capped register lets exactly 3 through and blocks 2 — never above 3.
    const statuses = await Promise.all(
      Array.from({ length: 5 }, () => {
        const res = makeRes();
        return handler(makeReq({ body }), res).then(() => res._status());
      }),
    );
    expect(statuses.filter((s) => s === 200).length).toBe(WORD_PRACTICE_MAX_ATTEMPTS);
    expect(statuses.filter((s) => s === 429).length).toBe(2);
    // Never exceeds the cap, and the failed (blocked) ones never refunded a
    // valid attempt (release is only reachable after a successful register).
    expect(store.counts.get(key)).toBe(WORD_PRACTICE_MAX_ATTEMPTS);
    expect(store.counts.get(key)!).toBeLessThanOrEqual(WORD_PRACTICE_MAX_ATTEMPTS);
  });
});
