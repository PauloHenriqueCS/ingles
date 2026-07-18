/**
 * Integration tests for generate-story-session.ts and generate-listening-story.ts
 * (story-session variant) — AI Gateway integration (Etapa 8D).
 *
 * Covers featureKey listening.story_session_generate (generateStorySession) and
 * listening.two_part_generate (generateListeningStory). Only the physical
 * openai.chat.completions.create(...) call inside each private callAI() is
 * wrapped — Azure TTS, storage upload, and answer-token signing are untouched
 * and are stubbed here only so the functions can run end-to-end.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockGatewayDeps, aiOk } from '../../../../api/__tests__/_ai-gateway-test-helpers';
import { estimateTtsCharacters, estimateProviderRequests } from '../../../../api/_ai-gateway/estimators';

const { mockCreate, gw, capturedContexts } = vi.hoisted(() => {
  const mockCreate = vi.fn();
  return {
    mockCreate,
    gw: {} as ReturnType<typeof import('../../../../api/__tests__/_ai-gateway-test-helpers').createMockGatewayDeps>,
    capturedContexts: [] as any[],
  };
});

vi.mock('../../../../api/_ai-gateway/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../api/_ai-gateway/index')>();
  return {
    ...actual,
    getProductionDeps: () => gw.mockDeps,
    executeAiGatewayCall: (async (context: any, ...rest: any[]) => {
      capturedContexts.push(context);
      return (actual.executeAiGatewayCall as any)(context, ...rest);
    }) as typeof actual.executeAiGatewayCall,
  };
});

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: mockCreate } } };
  }),
}));

vi.mock('../daily/resolve-user-listening-level', () => ({
  resolveUserListeningLevel: vi.fn().mockResolvedValue('B1'),
}));

import { generateStorySession } from './generate-story-session';
import { generateListeningStory } from './generate-listening-story';

const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000003';

const VALID_STORY_SESSION_JSON = JSON.stringify({
  title: 'A Short Trip',
  storyEn: 'Once upon a time...',
  storyPt: 'Era uma vez...',
  question: {
    prompt: 'What happened?',
    options: ['A', 'B', 'C', 'D', 'E'],
    correctIndex: 0,
    explanationPt: 'Porque sim.',
  },
});

const VALID_TWO_PART_JSON = JSON.stringify({
  title: 'A Longer Story',
  level: 'B1',
  summary: 'A story in two parts.',
  parts: [
    {
      id: 1,
      text: 'Part one text.',
      question: { text: 'Q1?', options: ['A', 'B', 'C', 'D', 'E'], correctIndex: 0, explanationPt: 'Pt' },
    },
    {
      id: 2,
      text: 'Part two text.',
      question: { text: 'Q2?', options: ['A', 'B', 'C', 'D', 'E'], correctIndex: 0, explanationPt: 'Pt' },
    },
  ],
});

function makeSupabase() {
  return {
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { audio_preferences: {} } }),
    })),
    storage: {
      from: vi.fn(() => ({
        upload: vi.fn().mockResolvedValue({ error: null }),
        createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://example.com/signed.mp3' }, error: null }),
      })),
    },
  } as any;
}

function mockFetchOk() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(16),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedContexts.length = 0;
  Object.assign(gw, createMockGatewayDeps());
  gw.resetDefaults();
  mockCreate.mockImplementation(() => aiOk(VALID_STORY_SESSION_JSON, { prompt_tokens: 100, completion_tokens: 50 }));
  global.fetch = mockFetchOk() as any;
});

// ── listening.story_session_generate ───────────────────────────────────────────

describe('generateStorySession — LEGACY mode', () => {
  it('returns the story and writes no telemetry', async () => {
    const result = await generateStorySession(USER_ID, makeSupabase(), 'key', 'azure-key', 'eastus', 'secret');
    expect(result.title).toBe('A Short Trip');
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
  });
});

describe('generateStorySession — OBSERVE mode', () => {
  beforeEach(() => {
    gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('records exactly one event with featureKey listening.story_session_generate (plus a separate one for the TTS call)', async () => {
    await generateStorySession(USER_ID, makeSupabase(), 'key', 'azure-key', 'eastus', 'secret');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(gw.mockStartEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        featureKey: 'listening.story_session_generate',
        provider: 'openai',
        service: 'chat.completions',
        model: 'gpt-4o-mini',
        userId: USER_ID,
        initiatedByUserId: USER_ID,
        actorType: 'user',
        executionLocation: 'system',
        attemptNumber: 1,
      }),
    );
    // One completed event for OpenAI generation, one for the Azure TTS call
    // that follows it in the same generateStorySession execution.
    expect(gw.mockCompleteEvent).toHaveBeenCalledTimes(2);
    const featureKeys = gw.mockStartEvent.mock.calls.map((c: any) => c[0].featureKey);
    expect(featureKeys).toEqual(['listening.story_session_generate', 'listening.story_session_tts']);
  });

  it('a provider error creates a failed event and the original error still propagates', async () => {
    mockCreate.mockRejectedValue(new Error('AI_EMPTY_RESPONSE'));
    await expect(
      generateStorySession(USER_ID, makeSupabase(), 'key', 'azure-key', 'eastus', 'secret'),
    ).rejects.toThrow();
    expect(gw.mockFailEvent).toHaveBeenCalledTimes(1);
  });

  it('metadata contains no story/question content', async () => {
    await generateStorySession(USER_ID, makeSupabase(), 'key', 'azure-key', 'eastus', 'secret');
    const startCall = gw.mockStartEvent.mock.calls[0][0] as any;
    const metadataStr = JSON.stringify(startCall.metadata);
    expect(metadataStr).not.toContain('A Short Trip');
    expect(metadataStr).not.toContain('Once upon a time');
  });
});

// ── listening.two_part_generate ─────────────────────────────────────────────────

describe('generateListeningStory (story-session) — LEGACY mode', () => {
  it('returns the two-part story and writes no telemetry', async () => {
    mockCreate.mockImplementation(() => aiOk(VALID_TWO_PART_JSON, { prompt_tokens: 200, completion_tokens: 100 }));
    const result = await generateListeningStory(USER_ID, makeSupabase(), 'key', 'azure-key', 'eastus', 'secret');
    expect(result.title).toBe('A Longer Story');
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
  });
});

describe('generateListeningStory (story-session) — OBSERVE mode', () => {
  beforeEach(() => {
    gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
    mockCreate.mockImplementation(() => aiOk(VALID_TWO_PART_JSON, { prompt_tokens: 200, completion_tokens: 100 }));
  });

  it('records exactly one event with featureKey listening.two_part_generate when generating fresh', async () => {
    await generateListeningStory(USER_ID, makeSupabase(), 'key', 'azure-key', 'eastus', 'secret');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(gw.mockStartEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        featureKey: 'listening.two_part_generate',
        provider: 'openai',
        model: 'gpt-4o-mini',
        userId: USER_ID,
        actorType: 'user',
        executionLocation: 'system',
        attemptNumber: 1,
      }),
    );
  });

  it('records input/output tokens from the real usage field', async () => {
    await generateListeningStory(USER_ID, makeSupabase(), 'key', 'azure-key', 'eastus', 'secret');
    const metrics = gw.mockInsertMetrics.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(metrics).toContainEqual(expect.objectContaining({ metricKey: 'input_text_tokens', quantity: 200 }));
    expect(metrics).toContainEqual(expect.objectContaining({ metricKey: 'output_text_tokens', quantity: 100 }));
    expect(metrics).toContainEqual(expect.objectContaining({ metricKey: 'provider_requests', quantity: 1, isBillable: false }));
  });

  it('idempotency: a supplied storyPackage skips OpenAI entirely — no physical call, no event (TTS still runs)', async () => {
    // First call (fresh) to obtain a valid packed storyPackage from a TTS failure path
    // is unnecessary here — we only need to prove that when storyPackage is present,
    // callAI (and therefore the listening.two_part_generate gateway event) is never
    // invoked. Force TTS failure on a fresh call to capture a real packed
    // storyPackage from StoryTtsError.
    let storyPackage: string | undefined;
    global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as any;
    try {
      await generateListeningStory(USER_ID, makeSupabase(), 'key', 'azure-key', 'eastus', 'secret');
    } catch (err: any) {
      storyPackage = err.storyPackage;
    }
    expect(storyPackage).toBeTruthy();
    expect(mockCreate).toHaveBeenCalledTimes(1); // the one fresh AI call above

    mockCreate.mockClear();
    gw.mockStartEvent.mockClear();
    global.fetch = mockFetchOk() as any; // TTS succeeds this time

    await generateListeningStory(USER_ID, makeSupabase(), 'key', 'azure-key', 'eastus', 'secret', storyPackage);

    expect(mockCreate).not.toHaveBeenCalled();
    // storyPackage only skips OpenAI generation — the two TTS physical calls
    // still happen and still create their own listening.two_part_tts events.
    const featureKeys = gw.mockStartEvent.mock.calls.map((c: any) => c[0].featureKey);
    expect(featureKeys).not.toContain('listening.two_part_generate');
    expect(featureKeys.filter((k: string) => k === 'listening.two_part_tts')).toHaveLength(2);
  });
});

// ── listening.story_session_tts ─────────────────────────────────────────────

describe('story_session synthesizeAudio — OBSERVE mode', () => {
  beforeEach(() => {
    gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('records exactly one event: featureKey listening.story_session_tts, provider azure, actorType user', async () => {
    await generateStorySession(USER_ID, makeSupabase(), 'key', 'azure-key', 'eastus', 'secret');
    const ttsCalls = gw.mockStartEvent.mock.calls.filter((c: any) => c[0].featureKey === 'listening.story_session_tts');
    expect(ttsCalls).toHaveLength(1);
    expect(ttsCalls[0][0]).toEqual(
      expect.objectContaining({
        provider: 'azure', service: 'tts_rest', userId: USER_ID, initiatedByUserId: USER_ID,
        actorType: 'user', executionLocation: 'system', attemptNumber: 1, callSequence: 1,
      }),
    );
  });

  it('records tts_characters (deterministic) and a non-billable provider_requests', async () => {
    await generateStorySession(USER_ID, makeSupabase(), 'key', 'azure-key', 'eastus', 'secret');
    const eventIdx = gw.mockStartEvent.mock.calls.findIndex((c: any) => c[0].featureKey === 'listening.story_session_tts');
    const metrics = gw.mockInsertMetrics.mock.calls[eventIdx][1] as Array<Record<string, unknown>>;
    expect(metrics).toContainEqual(expect.objectContaining({ metricKey: 'provider_requests', quantity: 1, isBillable: false }));
    const ttsMetric = metrics.find((m) => m.metricKey === 'tts_characters');
    expect(ttsMetric?.isBillable).toBe(true);
    expect((ttsMetric?.quantity as number)).toBeGreaterThan(0);
  });

  it('an Azure TTS error creates a failed event', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as any;
    await expect(
      generateStorySession(USER_ID, makeSupabase(), 'key', 'azure-key', 'eastus', 'secret'),
    ).rejects.toThrow();
    const ttsCalls = gw.mockFailEvent.mock.calls;
    expect(ttsCalls.length).toBeGreaterThan(0);
  });

  it('estimatedMetrics (the pre-call reservation) exactly matches the real SSML about to be sent — single physical attempt, not retried', async () => {
    const fetchSpy = mockFetchOk();
    global.fetch = fetchSpy as any;
    await generateStorySession(USER_ID, makeSupabase(), 'key', 'azure-key', 'eastus', 'secret');

    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const sentSsml = opts.body as string;
    const ttsContext = capturedContexts.find((c) => c.featureKey === 'listening.story_session_tts');
    expect(ttsContext).toBeDefined();
    expect(ttsContext.estimatedMetrics).toEqual([
      estimateProviderRequests(1),
      estimateTtsCharacters(sentSsml, true),
    ]);
  });
});

// ── listening.two_part_tts — parallel calls ─────────────────────────────────

describe('two_part synthesizeParts — OBSERVE mode, parallel TTS calls', () => {
  beforeEach(() => {
    gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
    mockCreate.mockImplementation(() => aiOk(VALID_TWO_PART_JSON, { prompt_tokens: 200, completion_tokens: 100 }));
  });

  it('records two events (part1, part2) sharing one correlationId with deterministic attemptNumber 1 and 2', async () => {
    await generateListeningStory(USER_ID, makeSupabase(), 'key', 'azure-key', 'eastus', 'secret');
    const ttsCalls = gw.mockStartEvent.mock.calls
      .map((c: any) => c[0])
      .filter((c: any) => c.featureKey === 'listening.two_part_tts');

    expect(ttsCalls).toHaveLength(2);
    expect(new Set(ttsCalls.map((c: any) => c.correlationId)).size).toBe(1);
    expect(ttsCalls.map((c: any) => c.attemptNumber).sort()).toEqual([1, 2]);
    expect(ttsCalls.map((c: any) => c.operationPart).sort()).toEqual(['part1', 'part2']);
  });

  it('attemptNumber reservation does not depend on which physical call resolves first', async () => {
    // part1 resolves slower than part2 — attemptNumber must still be 1/2 by
    // call order, not by resolution order (reserved synchronously before
    // Promise.all starts).
    let callIndex = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      const isFirstCall = callIndex === 0;
      callIndex += 1;
      const bytes = new ArrayBuffer(10);
      if (isFirstCall) {
        return new Promise((resolve) => setTimeout(() => resolve({ ok: true, status: 200, arrayBuffer: async () => bytes }), 20));
      }
      return Promise.resolve({ ok: true, status: 200, arrayBuffer: async () => bytes });
    }) as any;

    await generateListeningStory(USER_ID, makeSupabase(), 'key', 'azure-key', 'eastus', 'secret');
    const ttsCalls = gw.mockStartEvent.mock.calls
      .map((c: any) => c[0])
      .filter((c: any) => c.featureKey === 'listening.two_part_tts')
      .sort((a: any, b: any) => a.attemptNumber - b.attemptNumber);
    expect(ttsCalls[0]).toEqual(expect.objectContaining({ attemptNumber: 1, operationPart: 'part1' }));
    expect(ttsCalls[1]).toEqual(expect.objectContaining({ attemptNumber: 2, operationPart: 'part2' }));
  });

  it('each of the two physical TTS calls records its own independent tts_characters metric', async () => {
    await generateListeningStory(USER_ID, makeSupabase(), 'key', 'azure-key', 'eastus', 'secret');
    // Correlate by eventId (returned from startEvent, passed unchanged to
    // insertMetrics) rather than by array index, which is not guaranteed to
    // match startEvent's call order once two physical calls run concurrently.
    const ttsCallIndices = gw.mockStartEvent.mock.calls
      .map((c: any, i: number) => ({ featureKey: c[0].featureKey, i }))
      .filter((x) => x.featureKey === 'listening.two_part_tts')
      .map((x) => x.i);
    expect(ttsCallIndices).toHaveLength(2);

    const ttsEventIds = await Promise.all(ttsCallIndices.map((i) => gw.mockStartEvent.mock.results[i].value));
    const metricsCalls = gw.mockInsertMetrics.mock.calls.filter((c: any) => ttsEventIds.includes(c[0]));
    expect(metricsCalls).toHaveLength(2);
    for (const [, metrics] of metricsCalls) {
      const ttsMetric = (metrics as Array<Record<string, unknown>>).find((m) => m.metricKey === 'tts_characters');
      expect((ttsMetric?.quantity as number)).toBeGreaterThan(0);
    }
  });

  it('estimatedMetrics (the pre-call reservation) estimates each of the two physical blocks separately, matching each block\'s own real SSML — never a combined/duplicated total', async () => {
    const fetchCalls: RequestInit[] = [];
    global.fetch = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
      fetchCalls.push(opts);
      return Promise.resolve({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(10) });
    }) as any;

    await generateListeningStory(USER_ID, makeSupabase(), 'key', 'azure-key', 'eastus', 'secret');

    const ttsContexts = capturedContexts.filter((c) => c.featureKey === 'listening.two_part_tts');
    expect(ttsContexts).toHaveLength(2);
    expect(fetchCalls).toHaveLength(2);

    // Order-independent: each physical block's own SSML must be reflected by
    // exactly one reservation, with no duplication and no cross-block mixing.
    const expectedQuantities = fetchCalls
      .map((opts) => estimateTtsCharacters(opts.body as string, true).quantity)
      .sort((a, b) => a - b);
    const actualQuantities = ttsContexts
      .map((c) => (c.estimatedMetrics as Array<{ metricKey: string; quantity: number }>).find((m) => m.metricKey === 'tts_characters')?.quantity)
      .sort((a, b) => (a as number) - (b as number));
    expect(actualQuantities).toEqual(expectedQuantities);

    for (const c of ttsContexts) {
      expect(c.estimatedMetrics).toContainEqual(estimateProviderRequests(1));
    }
  });
});
