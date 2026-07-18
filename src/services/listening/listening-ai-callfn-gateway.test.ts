/**
 * Table-driven AI Gateway integration tests for the three shared AI-call-fn
 * factories (Etapa 8D):
 *
 *   - createDefaultAICallFn   (generate-listening-story.ts)   → listening.episode_generate_story
 *   - createQuestionAICallFn  (generate-listening-questions.ts) → listening.episode_generate_questions
 *   - createSubtitleAICallFn  (prepare-listening-subtitles.ts)  → listening.episode_translate_subtitles
 *
 * All three factories are called once per logical execution (once per cron-job
 * handler invocation, or once per on-demand step invocation) and return a
 * closure that may be invoked multiple times sequentially (block1/block2 for
 * story, generate+validate[+correct+re-validate] for questions, translate+
 * validate[+correct+re-validate] for subtitles). Since the gateway wrapping
 * lives inside the factory closure in all three cases, one shared suite proves
 * the wrapping is correct for every feature without duplicating the same
 * assertions three times — this also covers the "retry"/"multi-step" special
 * cases (block1→block2 retries, generation+validation, multiple subtitle
 * sub-calls): they all reduce to "N sequential closure invocations share one
 * correlationId and get a globally increasing attemptNumber", which is
 * asserted generically below for all three factories.
 *
 * None of the three call sites has a validated per-request userId in scope
 * (they are invoked identically from both the cron job queue and the
 * user-triggered on-demand pipeline, and the shared functions never receive
 * userId) — so all three are recorded as actorType 'system' with userId
 * undefined, consistent with the Fase 0 audit.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockGatewayDeps, aiOk } from '../../../api/__tests__/_ai-gateway-test-helpers';

const { mockCreate, gw } = vi.hoisted(() => {
  const mockCreate = vi.fn();
  return { mockCreate, gw: {} as ReturnType<typeof import('../../../api/__tests__/_ai-gateway-test-helpers').createMockGatewayDeps> };
});

vi.mock('../../../api/_ai-gateway/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/_ai-gateway/index')>();
  return { ...actual, getProductionDeps: () => gw.mockDeps };
});

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: mockCreate } } };
  }),
}));

import { createDefaultAICallFn } from './generate-listening-story';
import { createQuestionAICallFn, generateListeningQuestions, GENERATOR_PROMPT_VERSION } from './generate-listening-questions';
import { createSubtitleAICallFn } from './prepare-listening-subtitles';

function makeAwaitableChain(result: { data: unknown; error: unknown }) {
  const p: any = Promise.resolve(result);
  for (const m of ['select', 'insert', 'update', 'eq', 'or', 'order', 'in', 'not']) {
    p[m] = vi.fn().mockReturnValue(p);
  }
  p.limit = vi.fn().mockReturnValue(p);
  p.single = vi.fn().mockReturnValue(Promise.resolve(result));
  p.maybeSingle = vi.fn().mockReturnValue(Promise.resolve(result));
  return p;
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(gw, createMockGatewayDeps());
  gw.resetDefaults();
  mockCreate.mockImplementation(() => aiOk('hello world', { prompt_tokens: 100, completion_tokens: 50 }));
});

type CaseResult = string | { text: string };
function textOf(r: CaseResult): string {
  return typeof r === 'string' ? r : r.text;
}

const CASES: Array<{
  label: string;
  featureKey: string;
  model: string;
  makeFn: () => (systemPrompt: string, userPrompt: string) => Promise<CaseResult>;
}> = [
  { label: 'episode_generate_story', featureKey: 'listening.episode_generate_story', model: 'gpt-4o', makeFn: () => createDefaultAICallFn('key') },
  { label: 'episode_generate_questions', featureKey: 'listening.episode_generate_questions', model: 'gpt-4o-mini', makeFn: () => createQuestionAICallFn('key') as any },
  { label: 'episode_translate_subtitles', featureKey: 'listening.episode_translate_subtitles', model: 'gpt-4o-mini', makeFn: () => createSubtitleAICallFn('key') as any },
];

describe.each(CASES)('$label — factory-level gateway wrapping', ({ featureKey, model, makeFn }) => {
  describe('LEGACY mode', () => {
    it('returns the content and writes no telemetry', async () => {
      const callAI = makeFn();
      const result = await callAI('sys', 'user');
      expect(textOf(result)).toBe('hello world');
      expect(gw.mockStartEvent).not.toHaveBeenCalled();
      expect(gw.mockInsertMetrics).not.toHaveBeenCalled();
    });
  });

  describe('OBSERVE mode', () => {
    beforeEach(() => {
      gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
    });

    it(`records one event per physical call — featureKey ${featureKey}, provider openai, model ${model}, actorType system, userId undefined`, async () => {
      const callAI = makeFn();
      await callAI('sys', 'user');
      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(gw.mockStartEvent).toHaveBeenCalledTimes(1);
      expect(gw.mockStartEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          featureKey,
          provider: 'openai',
          service: 'chat.completions',
          model,
          userId: undefined,
          actorType: 'system',
          executionLocation: 'system',
          attemptNumber: 1,
          callSequence: 1,
        }),
      );
      expect(gw.mockCompleteEvent).toHaveBeenCalledTimes(1);
    });

    it('shares one correlationId and increments attemptNumber across repeated invocations of the same factory instance (retry / multi-step)', async () => {
      const callAI = makeFn(); // one factory instance == one logical execution
      await callAI('sys', 'p1');
      await callAI('sys', 'p2');
      await callAI('sys', 'p3');

      const calls = gw.mockStartEvent.mock.calls.map((c: any) => c[0]);
      expect(calls.map((c: any) => c.attemptNumber)).toEqual([1, 2, 3]);
      expect(new Set(calls.map((c: any) => c.correlationId)).size).toBe(1);
    });

    it('a new factory instance (new logical execution) gets a fresh correlationId and resets attemptNumber to 1', async () => {
      const callAI1 = makeFn();
      await callAI1('sys', 'p1');
      const callAI2 = makeFn();
      await callAI2('sys', 'p1');

      const [call1, call2] = gw.mockStartEvent.mock.calls.map((c: any) => c[0]);
      expect(call1.correlationId).not.toBe(call2.correlationId);
      expect(call1.attemptNumber).toBe(1);
      expect(call2.attemptNumber).toBe(1);
    });

    it('records input/output tokens from the real usage field and a non-billable provider_requests metric', async () => {
      mockCreate.mockImplementation(() => aiOk('{"ok":true}', { prompt_tokens: 77, completion_tokens: 33 }));
      const callAI = makeFn();
      await callAI('sys', 'user');
      const metrics = gw.mockInsertMetrics.mock.calls[0][1] as Array<Record<string, unknown>>;
      expect(metrics).toContainEqual(expect.objectContaining({ metricKey: 'provider_requests', quantity: 1, isBillable: false }));
      expect(metrics).toContainEqual(expect.objectContaining({ metricKey: 'input_text_tokens', quantity: 77, isBillable: true }));
      expect(metrics).toContainEqual(expect.objectContaining({ metricKey: 'output_text_tokens', quantity: 33, isBillable: true }));
    });

    it('records cached_input_tokens only when present and > 0', async () => {
      mockCreate.mockImplementation(() => aiOk('{"ok":true}', {
        prompt_tokens: 77, completion_tokens: 33,
        prompt_tokens_details: { cached_tokens: 15 },
      }));
      const callAI = makeFn();
      await callAI('sys', 'user');
      const metrics = gw.mockInsertMetrics.mock.calls[0][1] as Array<Record<string, unknown>>;
      expect(metrics).toContainEqual(expect.objectContaining({ metricKey: 'cached_input_tokens', quantity: 15, isBillable: true }));
    });

    it('does not record cached_input_tokens when zero', async () => {
      mockCreate.mockImplementation(() => aiOk('{"ok":true}', {
        prompt_tokens: 77, completion_tokens: 33,
        prompt_tokens_details: { cached_tokens: 0 },
      }));
      const callAI = makeFn();
      await callAI('sys', 'user');
      const metrics = gw.mockInsertMetrics.mock.calls[0][1] as Array<Record<string, unknown>>;
      expect(metrics.some((m) => m.metricKey === 'cached_input_tokens')).toBe(false);
    });

    it('a provider error creates a failed event and re-throws the original error unchanged', async () => {
      const err = Object.assign(new Error('boom'), { status: 500 });
      mockCreate.mockRejectedValue(err);
      const callAI = makeFn();
      await expect(callAI('sys', 'user')).rejects.toBe(err);
      expect(gw.mockFailEvent).toHaveBeenCalledTimes(1);
      expect(gw.mockCompleteEvent).not.toHaveBeenCalled();
    });

    it('metadata contains no prompt content — only allowlisted technical fields', async () => {
      const callAI = makeFn();
      await callAI('VERY SECRET SYSTEM PROMPT', 'VERY SECRET USER PROMPT');
      const startCall = gw.mockStartEvent.mock.calls[0][0] as any;
      expect(JSON.stringify(startCall.metadata)).not.toContain('SECRET');
    });

    it('telemetry failures (startEvent, insertMetrics, daily rollup) never break the physical call result', async () => {
      gw.mockStartEvent.mockRejectedValue(new Error('db down'));
      gw.mockInsertMetrics.mockRejectedValue(new Error('db down'));
      gw.mockRebuildBucketForEvent.mockRejectedValue(new Error('db down'));
      const callAI = makeFn();
      const result = await callAI('sys', 'user');
      expect(textOf(result)).toBe('hello world');
    });
  });
});

// ── episode_generate_story-specific: truncation after a successful physical call ──

describe('episode_generate_story — truncated output still records a succeeded event', () => {
  beforeEach(() => {
    gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('finish_reason "length" throws StoryOutputTruncatedError, but the physical call already succeeded', async () => {
    mockCreate.mockImplementation(() => Promise.resolve({
      choices: [{ message: { content: 'cut off...' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 50, completion_tokens: 1600 },
    }));
    const callAI = createDefaultAICallFn('key');
    await expect(callAI('sys', 'user')).rejects.toThrow(/truncated/i);
    expect(gw.mockCompleteEvent).toHaveBeenCalledTimes(1);
    expect(gw.mockFailEvent).not.toHaveBeenCalled();
  });
});

// ── episode_generate_questions — orchestration-level idempotency proof ─────────

describe('generateListeningQuestions — idempotent result skips OpenAI entirely', () => {
  const EPISODE_ID = 'eeeeeeee-0000-0000-0000-000000000001';

  function makeSupabase() {
    const from = vi.fn((table: string) => {
      if (table === 'listening_episodes') {
        return makeAwaitableChain({
          data: { id: EPISODE_ID, title: 't', synopsis: 's', cefr_level: 'B1', status: 'content_ready' },
          error: null,
        });
      }
      if (table === 'listening_questions') {
        return makeAwaitableChain({
          data: [
            { id: 'q1', question_order: 1, validation_status: 'valid', generator_prompt_version: GENERATOR_PROMPT_VERSION },
            { id: 'q2', question_order: 2, validation_status: 'valid', generator_prompt_version: GENERATOR_PROMPT_VERSION },
          ],
          error: null,
        });
      }
      return makeAwaitableChain({ data: null, error: null });
    });
    return { from } as any;
  }

  it('two valid current-version questions already exist → no physical call, no gateway event', async () => {
    gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
    const result = await generateListeningQuestions({ episodeId: EPISODE_ID }, undefined, makeSupabase());
    expect(result.questionCount).toBe(2);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
  });
});
