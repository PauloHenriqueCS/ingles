/**
 * AI Gateway — comprehensive test suite.
 *
 * Tests the gateway infrastructure in complete isolation:
 *   - No Supabase connections
 *   - No OpenAI calls
 *   - No Azure calls
 *   - No real clock
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  executeAiGatewayCall,
  GatewayError,
  isValidFeatureKey,
  assertFeatureKey,
  AI_FEATURE_KEYS,
  sanitizeMetadata,
  sanitizeError,
  GatewayPolicyResolver,
} from '../ai-gateway/index';

import type {
  GatewayCallContext,
  GatewayPolicy,
  GatewayDeps,
  GatewayUsageMetric,
  UsageRepositoryInterface,
  StartEventParams,
  CompleteEventParams,
  FailEventParams,
  CreateSessionParams,
  PolicyResolverInterface,
} from '../ai-gateway/index';

import {
  authorizeProviderSession,
  completeProviderSession,
  activateProviderSession,
  failProviderSession,
  expireProviderSession,
} from '../ai-gateway/provider-sessions';

// ── Mock helpers ──────────────────────────────────────────────────────────────

function makeMockRepo(overrides: Partial<UsageRepositoryInterface> = {}): UsageRepositoryInterface & {
  startCalls: StartEventParams[];
  completeCalls: Array<{ id: string; params: CompleteEventParams }>;
  failCalls: Array<{ id: string; params: FailEventParams }>;
  cancelCalls: string[];
  metricCalls: Array<{ eventId: string; metrics: GatewayUsageMetric[] }>;
  sessionCreateCalls: CreateSessionParams[];
  activateCalls: Array<{ id: string; providerSessionId?: string }>;
  completeSessions: Array<{ id: string; durationSeconds: number }>;
  failSessions: string[];
  expireSessions: string[];
} {
  const startCalls: StartEventParams[] = [];
  const completeCalls: Array<{ id: string; params: CompleteEventParams }> = [];
  const failCalls: Array<{ id: string; params: FailEventParams }> = [];
  const cancelCalls: string[] = [];
  const metricCalls: Array<{ eventId: string; metrics: GatewayUsageMetric[] }> = [];
  const sessionCreateCalls: CreateSessionParams[] = [];
  const activateCalls: Array<{ id: string; providerSessionId?: string }> = [];
  const completeSessions: Array<{ id: string; durationSeconds: number }> = [];
  const failSessions: string[] = [];
  const expireSessions: string[] = [];

  return {
    startCalls, completeCalls, failCalls, cancelCalls, metricCalls,
    sessionCreateCalls, activateCalls, completeSessions, failSessions, expireSessions,

    async startEvent(p) {
      startCalls.push(p);
      return overrides.startEvent ? overrides.startEvent(p) : 'event-id-1';
    },
    async completeEvent(id, p) {
      completeCalls.push({ id, params: p });
      if (overrides.completeEvent) await overrides.completeEvent(id, p);
    },
    async failEvent(id, p) {
      failCalls.push({ id, params: p });
      if (overrides.failEvent) await overrides.failEvent(id, p);
    },
    async cancelEvent(id) {
      cancelCalls.push(id);
      if (overrides.cancelEvent) await overrides.cancelEvent(id);
    },
    async insertMetrics(eventId, metrics) {
      metricCalls.push({ eventId, metrics });
      if (overrides.insertMetrics) await overrides.insertMetrics(eventId, metrics);
    },
    async createProviderSession(p) {
      sessionCreateCalls.push(p);
      return overrides.createProviderSession ? overrides.createProviderSession(p) : 'session-id-1';
    },
    async activateSession(id, providerSessionId) {
      activateCalls.push({ id, providerSessionId });
      if (overrides.activateSession) await overrides.activateSession(id, providerSessionId);
    },
    async completeSession(id, durationSeconds) {
      completeSessions.push({ id, durationSeconds });
      if (overrides.completeSession) await overrides.completeSession(id, durationSeconds);
    },
    async failSession(id) {
      failSessions.push(id);
      if (overrides.failSession) await overrides.failSession(id);
    },
    async expireSession(id) {
      expireSessions.push(id);
      if (overrides.expireSession) await overrides.expireSession(id);
    },
  };
}

function makeMockPolicyResolver(policy: GatewayPolicy): PolicyResolverInterface {
  return {
    resolvePolicy: vi.fn().mockResolvedValue(policy),
    invalidate: vi.fn(),
  } as unknown as PolicyResolverInterface;
}

function makeDeps(policy: GatewayPolicy, repoOverrides?: Partial<UsageRepositoryInterface>): GatewayDeps & {
  repo: ReturnType<typeof makeMockRepo>;
  logCalls: Array<{ event: string; data?: Record<string, unknown> }>;
} {
  const repo = makeMockRepo(repoOverrides);
  const logCalls: Array<{ event: string; data?: Record<string, unknown> }> = [];

  return {
    repo,
    logCalls,
    policyResolver: makeMockPolicyResolver(policy),
    usageRepository: repo,
    clock: vi.fn().mockReturnValue(1000),
    uuidGen: vi.fn().mockReturnValueOnce('req-uuid').mockReturnValueOnce('corr-uuid').mockReturnValue('other-uuid'),
    logger: (event, data) => logCalls.push({ event, data }),
  };
}

function baseContext(overrides: Partial<GatewayCallContext> = {}): GatewayCallContext {
  return {
    featureKey:        'writing.correct',
    provider:          'openai',
    actorType:         'user',
    executionLocation: 'backend',
    userId:            'user-123',
    ...overrides,
  };
}

// ── Feature catalog ───────────────────────────────────────────────────────────

describe('feature catalog', () => {
  it('contains exactly 25 feature keys', () => {
    expect(AI_FEATURE_KEYS).toHaveLength(25);
  });

  it('validates known keys', () => {
    expect(isValidFeatureKey('writing.correct')).toBe(true);
    expect(isValidFeatureKey('tts.synthesize')).toBe(true);
    expect(isValidFeatureKey('conversation.realtime_usage')).toBe(true);
  });

  it('rejects unknown keys', () => {
    expect(isValidFeatureKey('writing.nonexistent')).toBe(false);
    expect(isValidFeatureKey('')).toBe(false);
    expect(isValidFeatureKey('global')).toBe(false);
  });

  it('assertFeatureKey throws GatewayError for unknown key', () => {
    try {
      assertFeatureKey('bad.key');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GatewayError);
      expect((err as GatewayError).code).toBe('AI_GATEWAY_UNKNOWN_FEATURE');
    }
  });

  it('assertFeatureKey returns the key for known features', () => {
    expect(assertFeatureKey('listening.episode_synthesize_audio')).toBe('listening.episode_synthesize_audio');
  });

  it('all 25 expected keys are present', () => {
    const expected = [
      'conversation.preview_tts', 'conversation.create_session',
      'conversation.webrtc_connect', 'conversation.realtime_usage',
      'writing.correct', 'writing.correct_review', 'writing.compare_rewrite',
      'writing.correct_v2_text', 'writing.generate_topic', 'writing.explain_grammar',
      'writing.evaluate_rewrite', 'pronunciation.generate_text',
      'pronunciation.get_azure_token', 'pronunciation.start_assessment',
      'pronunciation.assess_text', 'tts.synthesize',
      'listening.story_session_generate', 'listening.story_session_tts',
      'listening.two_part_generate', 'listening.two_part_tts',
      'listening.episode_generate_story', 'listening.episode_generate_questions',
      'listening.episode_translate_synopsis', 'listening.episode_translate_subtitles',
      'listening.episode_synthesize_audio',
    ];
    expect([...AI_FEATURE_KEYS].sort()).toEqual([...expected].sort());
  });
});

// ── LEGACY mode ───────────────────────────────────────────────────────────────

describe('legacy mode', () => {
  it('calls invoke exactly once', async () => {
    const deps = makeDeps({ gatewayMode: 'legacy', runtimeStatus: 'enabled' });
    const invoke = vi.fn().mockResolvedValue('result');

    await executeAiGatewayCall(baseContext(), invoke, deps);

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('returns the same result as invoke', async () => {
    const deps = makeDeps({ gatewayMode: 'legacy', runtimeStatus: 'enabled' });
    const invoke = vi.fn().mockResolvedValue({ tokens: 42 });

    const result = await executeAiGatewayCall(baseContext(), invoke, deps);

    expect(result).toEqual({ tokens: 42 });
  });

  it('does not record any usage events', async () => {
    const deps = makeDeps({ gatewayMode: 'legacy', runtimeStatus: 'enabled' });
    await executeAiGatewayCall(baseContext(), () => Promise.resolve('ok'), deps);

    expect(deps.repo.startCalls).toHaveLength(0);
    expect(deps.repo.completeCalls).toHaveLength(0);
  });

  it('does not record any metrics', async () => {
    const deps = makeDeps({ gatewayMode: 'legacy', runtimeStatus: 'enabled' });
    const extract = vi.fn().mockReturnValue([]);

    await executeAiGatewayCall(baseContext(), () => Promise.resolve('ok'), deps, extract);

    expect(extract).not.toHaveBeenCalled();
    expect(deps.repo.metricCalls).toHaveLength(0);
  });

  it('preserves the original error from invoke', async () => {
    const deps = makeDeps({ gatewayMode: 'legacy', runtimeStatus: 'enabled' });
    const originalError = new Error('provider failure');
    const invoke = vi.fn().mockRejectedValue(originalError);

    await expect(executeAiGatewayCall(baseContext(), invoke, deps)).rejects.toBe(originalError);
  });

  it('does not touch the repository even when invoke fails', async () => {
    const deps = makeDeps({ gatewayMode: 'legacy', runtimeStatus: 'enabled' });
    await expect(
      executeAiGatewayCall(baseContext(), () => Promise.reject(new Error('boom')), deps),
    ).rejects.toThrow();

    expect(deps.repo.startCalls).toHaveLength(0);
    expect(deps.repo.failCalls).toHaveLength(0);
  });
});

// ── OBSERVE mode ──────────────────────────────────────────────────────────────

describe('observe mode', () => {
  it('creates a started event before invoking', async () => {
    const deps = makeDeps({ gatewayMode: 'observe', runtimeStatus: 'enabled' });

    await executeAiGatewayCall(baseContext(), () => Promise.resolve('ok'), deps);

    expect(deps.repo.startCalls).toHaveLength(1);
    expect(deps.repo.startCalls[0].featureKey).toBe('writing.correct');
    expect(deps.repo.startCalls[0].actorType).toBe('user');
  });

  it('records success after invoke resolves', async () => {
    const deps = makeDeps({ gatewayMode: 'observe', runtimeStatus: 'enabled' });

    await executeAiGatewayCall(baseContext(), () => Promise.resolve('ok'), deps);

    expect(deps.repo.completeCalls).toHaveLength(1);
    expect(deps.repo.completeCalls[0].id).toBe('event-id-1');
  });

  it('records failure and re-throws original error when invoke rejects', async () => {
    const deps = makeDeps({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
    const originalError = new Error('OpenAI timeout');

    await expect(
      executeAiGatewayCall(baseContext(), () => Promise.reject(originalError), deps),
    ).rejects.toBe(originalError);

    expect(deps.repo.failCalls).toHaveLength(1);
    expect(deps.repo.completeCalls).toHaveLength(0);
  });

  it('inserts metrics when an extractor is provided', async () => {
    const deps = makeDeps({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
    const metrics: GatewayUsageMetric[] = [{
      metricKey:         'output_text_tokens',
      unitType:          'tokens',
      quantity:          150,
      isBillable:        true,
      measurementSource: 'provider_usage',
    }];
    const extract = vi.fn().mockReturnValue(metrics);

    await executeAiGatewayCall(baseContext(), () => Promise.resolve('ok'), deps, extract);

    expect(deps.repo.metricCalls).toHaveLength(1);
    expect(deps.repo.metricCalls[0].metrics).toEqual(metrics);
  });

  it('calls invoke exactly once', async () => {
    const deps = makeDeps({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
    const invoke = vi.fn().mockResolvedValue('ok');

    await executeAiGatewayCall(baseContext(), invoke, deps);

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('telemetry failure in startEvent does not block invoke or result', async () => {
    const deps = makeDeps({ gatewayMode: 'observe', runtimeStatus: 'enabled' }, {
      startEvent: async () => { throw new Error('DB down'); },
    });
    const invoke = vi.fn().mockResolvedValue('success');

    const result = await executeAiGatewayCall(baseContext(), invoke, deps);

    expect(result).toBe('success');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('telemetry failure in completeEvent does not break the returned result', async () => {
    const deps = makeDeps({ gatewayMode: 'observe', runtimeStatus: 'enabled' }, {
      completeEvent: async () => { throw new Error('DB write failed'); },
    });

    const result = await executeAiGatewayCall(baseContext(), () => Promise.resolve('value'), deps);

    expect(result).toBe('value');
  });

  it('extractor failure does not cause invoke to be called again', async () => {
    const deps = makeDeps({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
    const invoke = vi.fn().mockResolvedValue('ok');
    const extract = vi.fn().mockImplementation(() => { throw new Error('extract crash'); });

    const result = await executeAiGatewayCall(baseContext(), invoke, deps, extract);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result).toBe('ok');
  });

  it('original invoke error is re-thrown even when failEvent also fails', async () => {
    const originalError = new Error('provider error');
    const deps = makeDeps({ gatewayMode: 'observe', runtimeStatus: 'enabled' }, {
      failEvent: async () => { throw new Error('telemetry error'); },
    });

    await expect(
      executeAiGatewayCall(baseContext(), () => Promise.reject(originalError), deps),
    ).rejects.toBe(originalError);
  });

  it('records context fields in the started event', async () => {
    const deps = makeDeps({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
    const ctx = baseContext({
      correlationId: 'corr-123',
      idempotencyKey: 'idem-abc',
      attemptNumber: 2,
      callSequence: 1,
      operationPart: 'block_1',
    });

    await executeAiGatewayCall(ctx, () => Promise.resolve('ok'), deps);

    const startCall = deps.repo.startCalls[0];
    expect(startCall.correlationId).toBe('corr-123');
    expect(startCall.idempotencyKey).toBe('idem-abc');
    expect(startCall.attemptNumber).toBe(2);
    expect(startCall.operationPart).toBe('block_1');
  });

  it('does not insert metrics when extractor returns empty array', async () => {
    const deps = makeDeps({ gatewayMode: 'observe', runtimeStatus: 'enabled' });

    await executeAiGatewayCall(baseContext(), () => Promise.resolve('ok'), deps, () => []);

    expect(deps.repo.metricCalls).toHaveLength(0);
  });
});

// ── ENFORCE mode ──────────────────────────────────────────────────────────────

describe('enforce mode', () => {
  it('does not call invoke', async () => {
    const deps = makeDeps({ gatewayMode: 'enforce', runtimeStatus: 'enabled' });
    const invoke = vi.fn().mockResolvedValue('ok');

    await expect(executeAiGatewayCall(baseContext(), invoke, deps)).rejects.toThrow();

    expect(invoke).not.toHaveBeenCalled();
  });

  it('throws a GatewayError with code AI_GATEWAY_ENFORCEMENT_NOT_READY', async () => {
    const deps = makeDeps({ gatewayMode: 'enforce', runtimeStatus: 'enabled' });

    try {
      await executeAiGatewayCall(baseContext(), () => Promise.resolve('ok'), deps);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GatewayError);
      expect((err as GatewayError).code).toBe('AI_GATEWAY_ENFORCEMENT_NOT_READY');
    }
  });

  it('does not record any usage events', async () => {
    const deps = makeDeps({ gatewayMode: 'enforce', runtimeStatus: 'enabled' });

    await expect(
      executeAiGatewayCall(baseContext(), () => Promise.resolve('ok'), deps),
    ).rejects.toThrow();

    expect(deps.repo.startCalls).toHaveLength(0);
    expect(deps.repo.completeCalls).toHaveLength(0);
    expect(deps.repo.failCalls).toHaveLength(0);
  });
});

// ── POLICY resolution ─────────────────────────────────────────────────────────

describe('GatewayPolicyResolver', () => {
  it('returns legacy+enabled when Supabase is not configured', async () => {
    const resolver = new GatewayPolicyResolver(null);
    const policy = await resolver.resolvePolicy(baseContext());

    expect(policy.gatewayMode).toBe('legacy');
    expect(policy.runtimeStatus).toBe('enabled');
  });

  it('returns cached policy on second call within TTL', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          or: vi.fn().mockResolvedValue({
            data: [{ scope_type: 'global', gateway_mode: 'observe', runtime_status: 'enabled' }],
            error: null,
          }),
        }),
      }),
    };

    const resolver = new GatewayPolicyResolver(mockSupabase as any, 5000);
    const ctx = baseContext();

    const first  = await resolver.resolvePolicy(ctx);
    const second = await resolver.resolvePolicy(ctx);

    expect(first).toEqual(second);
    // Only one DB query due to cache
    expect(mockSupabase.from).toHaveBeenCalledTimes(1);
  });

  it('uses last valid policy when Supabase fails after a successful fetch', async () => {
    let callCount = 0;
    const mockSupabase = {
      from: vi.fn().mockImplementation(() => ({
        select: () => ({
          or: () => {
            callCount++;
            if (callCount === 1) {
              return Promise.resolve({
                data: [{ scope_type: 'global', gateway_mode: 'observe', runtime_status: 'enabled' }],
                error: null,
              });
            }
            return Promise.resolve({ data: null, error: { message: 'DB unavailable' } });
          },
        }),
      })),
    };

    let fakeTime = 1000;
    const fakeClock = () => fakeTime;
    const resolver = new GatewayPolicyResolver(mockSupabase as any, 5000, fakeClock);
    const ctx = baseContext();

    const first = await resolver.resolvePolicy(ctx);
    expect(first.gatewayMode).toBe('observe');

    fakeTime = 7000; // advance clock past TTL (1000 + 5000 + 1000)

    const second = await resolver.resolvePolicy(ctx);
    // Should fall back to last known good policy
    expect(second.gatewayMode).toBe('observe');
  });

  it('returns legacy+enabled when no prior policy exists and Supabase fails', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          or: vi.fn().mockResolvedValue({ data: null, error: { message: 'DB error' } }),
        }),
      }),
    };

    const resolver = new GatewayPolicyResolver(mockSupabase as any, 0);
    const policy = await resolver.resolvePolicy(baseContext());

    expect(policy.gatewayMode).toBe('legacy');
    expect(policy.runtimeStatus).toBe('enabled');
  });

  it('feature scope overrides global gateway_mode', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          or: vi.fn().mockResolvedValue({
            data: [
              { scope_type: 'global',  gateway_mode: 'legacy',  runtime_status: 'enabled' },
              { scope_type: 'feature', gateway_mode: 'observe', runtime_status: 'enabled' },
            ],
            error: null,
          }),
        }),
      }),
    };

    const resolver = new GatewayPolicyResolver(mockSupabase as any, 0);
    const policy = await resolver.resolvePolicy(baseContext());

    expect(policy.gatewayMode).toBe('observe'); // feature wins
  });

  it('user scope overrides feature gateway_mode', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          or: vi.fn().mockResolvedValue({
            data: [
              { scope_type: 'global',  gateway_mode: 'legacy',  runtime_status: 'enabled' },
              { scope_type: 'feature', gateway_mode: 'observe', runtime_status: 'enabled' },
              { scope_type: 'user',    gateway_mode: 'enforce', runtime_status: 'enabled' },
            ],
            error: null,
          }),
        }),
      }),
    };

    const resolver = new GatewayPolicyResolver(mockSupabase as any, 0);
    const policy = await resolver.resolvePolicy(baseContext({ userId: 'user-abc' }));

    expect(policy.gatewayMode).toBe('enforce'); // user wins
  });

  it('provider scope is considered for gateway_mode between global and feature', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          or: vi.fn().mockResolvedValue({
            data: [
              { scope_type: 'global',   gateway_mode: 'legacy',  runtime_status: 'enabled' },
              { scope_type: 'provider', gateway_mode: 'observe', runtime_status: 'enabled' },
            ],
            error: null,
          }),
        }),
      }),
    };

    const resolver = new GatewayPolicyResolver(mockSupabase as any, 0);
    const policy = await resolver.resolvePolicy(baseContext());

    expect(policy.gatewayMode).toBe('observe'); // provider is more specific than global
  });

  it('disabled runtime_status from upper scope cannot be re-enabled by lower scope', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          or: vi.fn().mockResolvedValue({
            data: [
              { scope_type: 'global',  gateway_mode: 'legacy', runtime_status: 'disabled' },
              { scope_type: 'feature', gateway_mode: 'legacy', runtime_status: 'enabled'  },
            ],
            error: null,
          }),
        }),
      }),
    };

    const resolver = new GatewayPolicyResolver(mockSupabase as any, 0);
    const policy = await resolver.resolvePolicy(baseContext());

    expect(policy.runtimeStatus).toBe('disabled'); // global disabled persists
  });

  it('paused_automatically is more restrictive than cache_only', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          or: vi.fn().mockResolvedValue({
            data: [
              { scope_type: 'global',  gateway_mode: 'legacy', runtime_status: 'cache_only'           },
              { scope_type: 'feature', gateway_mode: 'legacy', runtime_status: 'paused_automatically' },
            ],
            error: null,
          }),
        }),
      }),
    };

    const resolver = new GatewayPolicyResolver(mockSupabase as any, 0);
    const policy = await resolver.resolvePolicy(baseContext());

    expect(policy.runtimeStatus).toBe('paused_automatically');
  });

  it('invalidate clears the cache', async () => {
    let callCount = 0;
    const mockSupabase = {
      from: vi.fn().mockImplementation(() => ({
        select: () => ({
          or: () => {
            callCount++;
            return Promise.resolve({
              data: [{ scope_type: 'global', gateway_mode: 'observe', runtime_status: 'enabled' }],
              error: null,
            });
          },
        }),
      })),
    };

    const resolver = new GatewayPolicyResolver(mockSupabase as any, 60_000);
    const ctx = baseContext();

    await resolver.resolvePolicy(ctx);
    resolver.invalidate();
    await resolver.resolvePolicy(ctx);

    expect(callCount).toBe(2); // second call hit DB after invalidation
  });
});

// ── SANITIZE ──────────────────────────────────────────────────────────────────

describe('sanitizeMetadata', () => {
  it('removes token key', () => {
    const result = sanitizeMetadata({ token: 'secret-abc', model: 'gpt-4' });
    expect(result).not.toHaveProperty('token');
    expect(result['model']).toBe('gpt-4');
  });

  it('removes authorization key', () => {
    const result = sanitizeMetadata({ authorization: 'Bearer sk-123', latency: 100 });
    expect(result).not.toHaveProperty('authorization');
    expect(result['latency']).toBe(100);
  });

  it('removes prompt key', () => {
    const result = sanitizeMetadata({ prompt: 'Write me an essay', requestId: 'r1' });
    expect(result).not.toHaveProperty('prompt');
    expect(result['requestId']).toBe('r1');
  });

  it('removes text key', () => {
    const result = sanitizeMetadata({ text: 'user essay content', tokens: 42 });
    expect(result).not.toHaveProperty('text');
  });

  it('removes audio key', () => {
    const result = sanitizeMetadata({ audio: Buffer.from('wav-data'), format: 'wav' });
    expect(result).not.toHaveProperty('audio');
    expect(result['format']).toBe('wav');
  });

  it('removes response key', () => {
    const result = sanitizeMetadata({ response: 'full AI answer here', model: 'gpt-4o' });
    expect(result).not.toHaveProperty('response');
  });

  it('removes content key', () => {
    const result = sanitizeMetadata({ content: 'chat message', retries: 0 });
    expect(result).not.toHaveProperty('content');
  });

  it('removes ssml key', () => {
    const result = sanitizeMetadata({ ssml: '<speak>hello</speak>', voice: 'alloy' });
    expect(result).not.toHaveProperty('ssml');
    expect(result['voice']).toBe('alloy');
  });

  it('removes body key', () => {
    const result = sanitizeMetadata({ body: { something: 'here' }, attempts: 1 });
    expect(result).not.toHaveProperty('body');
  });

  it('removes password and cookie keys', () => {
    const result = sanitizeMetadata({ password: 'pw', cookie: 'session=abc', status: 200 });
    expect(result).not.toHaveProperty('password');
    expect(result).not.toHaveProperty('cookie');
    expect(result['status']).toBe(200);
  });

  it('truncates long strings', () => {
    const long = 'a'.repeat(1000);
    const result = sanitizeMetadata({ model: long });
    expect((result['model'] as string).length).toBeLessThanOrEqual(260); // 256 + ellipsis
  });

  it('accepts safe technical metadata', () => {
    const safe = { model: 'gpt-4o', attempts: 2, region: 'eastus', latencyMs: 450 };
    const result = sanitizeMetadata(safe);
    expect(result['model']).toBe('gpt-4o');
    expect(result['attempts']).toBe(2);
    expect(result['region']).toBe('eastus');
    expect(result['latencyMs']).toBe(450);
  });

  it('limits depth and returns _truncated for deep objects', () => {
    const deep = { a: { b: { c: { d: { e: { f: 'too deep' } } } } } };
    const result = sanitizeMetadata(deep);
    // Should not crash and should truncate at some depth
    expect(result).toBeDefined();
    expect(JSON.stringify(result)).not.toContain('too deep');
  });

  it('handles circular references without throwing', () => {
    const obj: Record<string, unknown> = { model: 'gpt-4' };
    obj['self'] = obj;
    expect(() => sanitizeMetadata(obj)).not.toThrow();
  });

  it('returns empty object for non-objects', () => {
    expect(sanitizeMetadata('string')).toEqual({});
    expect(sanitizeMetadata(42)).toEqual({});
    expect(sanitizeMetadata(null)).toEqual({});
  });
});

describe('sanitizeError', () => {
  it('extracts http status without including raw message containing secrets', () => {
    const err = { status: 429, message: 'Rate limited for key sk-abc123' };
    const result = sanitizeError(err);
    expect(result.httpStatus).toBe(429);
    expect(JSON.stringify(result)).not.toContain('sk-abc123');
  });

  it('includes safe message when no secrets detected', () => {
    const err = new Error('Connection refused by upstream');
    const result = sanitizeError(err);
    expect(result.sanitizedMessage).toBe('Connection refused by upstream');
  });

  it('redacts message containing bearer token pattern', () => {
    const err = new Error('Invalid Bearer eyJhbGciOiJ token');
    const result = sanitizeError(err);
    expect(result.sanitizedMessage).toBeUndefined();
  });

  it('includes context fields when provided', () => {
    const result = sanitizeError(new Error('timeout'), {
      provider: 'openai',
      model: 'gpt-4o',
      latencyMs: 5000,
    });
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-4o');
    expect(result.latencyMs).toBe(5000);
  });

  it('handles non-Error objects gracefully', () => {
    expect(() => sanitizeError('string error')).not.toThrow();
    expect(() => sanitizeError(null)).not.toThrow();
    expect(() => sanitizeError(undefined)).not.toThrow();
  });
});

// ── PROVIDER SESSIONS ─────────────────────────────────────────────────────────

describe('authorizeProviderSession', () => {
  it('does not store the token in the repository', async () => {
    const repo = makeMockRepo();
    const token = 'ephemeral-secret-token-abc123';

    await authorizeProviderSession(repo, {
      featureKey: 'conversation.webrtc_connect',
      provider: 'openai',
      userId: 'user-42',
    }, token);

    const call = repo.sessionCreateCalls[0];
    expect(JSON.stringify(call)).not.toContain(token);
    expect(JSON.stringify(call)).not.toContain('ephemeral-secret-token-abc123');
  });

  it('stores only the SHA-256 fingerprint', async () => {
    const repo = makeMockRepo();
    const token = 'my-secret-token';

    const { authorizationFingerprint } = await authorizeProviderSession(repo, {
      featureKey: 'conversation.webrtc_connect',
      provider: 'openai',
      userId: 'user-42',
    }, token);

    // Must be a 64-char hex string (SHA-256)
    expect(authorizationFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(repo.sessionCreateCalls[0].authorizationFingerprint).toBe(authorizationFingerprint);
  });

  it('preserves user_id in the session record', async () => {
    const repo = makeMockRepo();

    await authorizeProviderSession(repo, {
      featureKey: 'conversation.webrtc_connect',
      provider: 'openai',
      userId: 'user-99',
    }, 'any-token');

    expect(repo.sessionCreateCalls[0].userId).toBe('user-99');
  });

  it('accepts null user_id for system/cron sessions', async () => {
    const repo = makeMockRepo();

    await expect(
      authorizeProviderSession(repo, {
        featureKey: 'pronunciation.assess_text',
        provider: 'azure',
        userId: undefined,
        initiatedByUserId: undefined,
      }, 'any-token'),
    ).resolves.toBeDefined();

    expect(repo.sessionCreateCalls[0].userId).toBeUndefined();
  });

  it('returns the session ID from the repository', async () => {
    const repo = makeMockRepo({ createProviderSession: async () => 'custom-session-id' });

    const result = await authorizeProviderSession(repo, {
      featureKey: 'conversation.webrtc_connect',
      provider: 'openai',
    }, 'token-xyz');

    expect(result.sessionId).toBe('custom-session-id');
  });

  it('two different tokens produce different fingerprints', async () => {
    const repo1 = makeMockRepo();
    const repo2 = makeMockRepo();

    const { authorizationFingerprint: fp1 } = await authorizeProviderSession(
      repo1, { featureKey: 'conversation.webrtc_connect', provider: 'openai' }, 'token-A',
    );
    const { authorizationFingerprint: fp2 } = await authorizeProviderSession(
      repo2, { featureKey: 'conversation.webrtc_connect', provider: 'openai' }, 'token-B',
    );

    expect(fp1).not.toBe(fp2);
  });
});

describe('session lifecycle transitions', () => {
  it('activateSession calls through to repo', async () => {
    const repo = makeMockRepo();
    await activateProviderSession(repo, 'session-1', 'provider-session-abc');

    expect(repo.activateCalls).toHaveLength(1);
    expect(repo.activateCalls[0].id).toBe('session-1');
    expect(repo.activateCalls[0].providerSessionId).toBe('provider-session-abc');
  });

  it('completeSession calls through with duration', async () => {
    const repo = makeMockRepo();
    await completeProviderSession(repo, 'session-2', 120.5);

    expect(repo.completeSessions[0]).toEqual({ id: 'session-2', durationSeconds: 120.5 });
  });

  it('completeProviderSession rejects negative duration', async () => {
    const repo = makeMockRepo();
    await expect(completeProviderSession(repo, 'session-3', -1)).rejects.toThrow();
  });

  it('completeProviderSession accepts zero duration', async () => {
    const repo = makeMockRepo();
    await expect(completeProviderSession(repo, 'session-4', 0)).resolves.toBeUndefined();
  });

  it('failSession calls through to repo', async () => {
    const repo = makeMockRepo();
    await failProviderSession(repo, 'session-5');

    expect(repo.failSessions).toContain('session-5');
  });

  it('expireSession calls through to repo', async () => {
    const repo = makeMockRepo();
    await expireProviderSession(repo, 'session-6');

    expect(repo.expireSessions).toContain('session-6');
  });
});

// ── SupabaseUsageRepository validation ───────────────────────────────────────

describe('SupabaseUsageRepository.completeSession', () => {
  it('rejects negative duration before any DB call', async () => {
    const { SupabaseUsageRepository } = await import('../ai-gateway/usage-repository');

    const mockClient = {
      from: vi.fn().mockReturnValue({
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ error: null }),
      }),
    };

    const repo = new SupabaseUsageRepository(mockClient as any);

    await expect(repo.completeSession('id', -5)).rejects.toThrow('negative');
    expect(mockClient.from).not.toHaveBeenCalled();
  });
});

// ── TTL and clock injection ───────────────────────────────────────────────────

describe('GatewayPolicyResolver — TTL and clock injection', () => {
  it('reuses cached policy when clock has not advanced past TTL', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          or: vi.fn().mockResolvedValue({
            data: [{ scope_type: 'global', gateway_mode: 'observe', runtime_status: 'enabled' }],
            error: null,
          }),
        }),
      }),
    };

    let fakeTime = 1000;
    const fakeClock = () => fakeTime;
    const resolver = new GatewayPolicyResolver(mockSupabase as any, 5000, fakeClock);
    const ctx = baseContext();

    await resolver.resolvePolicy(ctx);
    fakeTime = 5999; // still within TTL: 1000 + 5000 - 1
    await resolver.resolvePolicy(ctx);

    expect(mockSupabase.from).toHaveBeenCalledTimes(1); // second call was a cache hit
  });

  it('re-fetches policy after clock advances past TTL', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          or: vi.fn().mockResolvedValue({
            data: [{ scope_type: 'global', gateway_mode: 'observe', runtime_status: 'enabled' }],
            error: null,
          }),
        }),
      }),
    };

    let fakeTime = 1000;
    const fakeClock = () => fakeTime;
    const resolver = new GatewayPolicyResolver(mockSupabase as any, 5000, fakeClock);
    const ctx = baseContext();

    await resolver.resolvePolicy(ctx);
    fakeTime = 6001; // past TTL: 1000 + 5000 + 1
    await resolver.resolvePolicy(ctx);

    expect(mockSupabase.from).toHaveBeenCalledTimes(2); // second call hit DB
  });

  it('injected clock determines TTL boundary precisely', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          or: vi.fn().mockResolvedValue({
            data: [{ scope_type: 'global', gateway_mode: 'legacy', runtime_status: 'enabled' }],
            error: null,
          }),
        }),
      }),
    };

    let fakeTime = 0;
    const fakeClock = () => fakeTime;
    const resolver = new GatewayPolicyResolver(mockSupabase as any, 100, fakeClock);
    const ctx = baseContext();

    await resolver.resolvePolicy(ctx); // fetch at t=0, expiresAt=100
    fakeTime = 100; // exactly at boundary — clock() < expiresAt is 100 < 100 = false → expired
    await resolver.resolvePolicy(ctx);

    expect(mockSupabase.from).toHaveBeenCalledTimes(2);
  });

  it('invalidation forces re-fetch even when clock is within TTL', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          or: vi.fn().mockResolvedValue({
            data: [{ scope_type: 'global', gateway_mode: 'observe', runtime_status: 'enabled' }],
            error: null,
          }),
        }),
      }),
    };

    const fakeClock = () => 1000; // clock never advances
    const resolver = new GatewayPolicyResolver(mockSupabase as any, 60_000, fakeClock);
    const ctx = baseContext();

    await resolver.resolvePolicy(ctx); // fetch #1, cache valid until t=61000
    resolver.invalidate();             // clear cache while still within TTL
    await resolver.resolvePolicy(ctx); // must fetch again — not from cache

    expect(mockSupabase.from).toHaveBeenCalledTimes(2);
  });

  it('returns stale policy when re-fetch fails after TTL expires, no real wait needed', async () => {
    let callCount = 0;
    const mockSupabase = {
      from: vi.fn().mockImplementation(() => ({
        select: () => ({
          or: () => {
            callCount++;
            return callCount === 1
              ? Promise.resolve({ data: [{ scope_type: 'global', gateway_mode: 'observe', runtime_status: 'enabled' }], error: null })
              : Promise.resolve({ data: null, error: { message: 'DB down' } });
          },
        }),
      })),
    };

    let fakeTime = 1000;
    const fakeClock = () => fakeTime;
    const resolver = new GatewayPolicyResolver(mockSupabase as any, 5000, fakeClock);
    const ctx = baseContext();

    const p1 = await resolver.resolvePolicy(ctx);
    expect(p1.gatewayMode).toBe('observe');

    fakeTime = 7000; // past TTL — no real sleep
    const p2 = await resolver.resolvePolicy(ctx);
    expect(p2.gatewayMode).toBe('observe'); // stale cache used as fallback
  });
});

// ── Unknown feature key ───────────────────────────────────────────────────────

describe('unknown feature key', () => {
  it('throws GatewayError.AI_GATEWAY_UNKNOWN_FEATURE before policy resolution', async () => {
    const deps = makeDeps({ gatewayMode: 'legacy', runtimeStatus: 'enabled' });
    const ctx = { ...baseContext(), featureKey: 'bad.feature' as any };

    try {
      await executeAiGatewayCall(ctx, () => Promise.resolve('ok'), deps);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GatewayError);
      expect((err as GatewayError).code).toBe('AI_GATEWAY_UNKNOWN_FEATURE');
    }

    expect((deps.policyResolver.resolvePolicy as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
