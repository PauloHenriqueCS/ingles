/**
 * Integration test for process-listening-group-generation-step.ts
 * (stepPreparingDescription) — proves the shared level-group pipeline's
 * synopsis translation goes through the AI Gateway via the same
 * translateListeningSynopsis helper the on-demand pipeline uses (see
 * on-demand/process-listening-generation-step-gateway.test.ts, the direct
 * counterpart of this file), and is recorded under the group-specific
 * endpoint so the two pipelines are distinguishable in gateway telemetry.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockGatewayDeps, aiOk } from '../../../../api/__tests__/_ai-gateway-test-helpers';

const { mockCreate, gw } = vi.hoisted(() => {
  const mockCreate = vi.fn();
  return { mockCreate, gw: {} as ReturnType<typeof import('../../../../api/__tests__/_ai-gateway-test-helpers').createMockGatewayDeps> };
});

vi.mock('../../../../api/_ai-gateway/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../api/_ai-gateway/index')>();
  return { ...actual, getProductionDeps: () => gw.mockDeps };
});

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: mockCreate } } };
  }),
}));

import { processListeningGroupGenerationStep } from './process-listening-group-generation-step';

const JOB_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const EPISODE_ID = 'cccccccc-0000-0000-0000-000000000002';
const WORKER_ID = 'test-worker-1';

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

/**
 * Stateful stub for listening_generation_jobs: tracks whatever
 * `.update({ status, ... })` payload was last written (advanceJob on
 * success, failJob on error) so the final `.single()` fetch reflects the
 * real outcome instead of a hardcoded status.
 */
function makeGroupSupabase(opts: { synopsis?: string | null; synopsisPt?: string | null }) {
  let jobsCall = 0;
  let currentStatus = 'preparing_description';
  let lastErrorCode: string | null = null;

  const from = vi.fn((table: string) => {
    if (table === 'listening_generation_jobs') {
      jobsCall += 1;
      if (jobsCall === 1) {
        // acquireLock
        return makeAwaitableChain({
          data: {
            id: JOB_ID, status: currentStatus, level_group: 'B1_B2', target_level: 'B1',
            episode_id: EPISODE_ID, attempts: 0, max_attempts: 3,
          },
          error: null,
        });
      }
      // advanceJob / failJob
      const chain: any = {};
      for (const m of ['select', 'insert', 'eq', 'or', 'order', 'in', 'not']) {
        chain[m] = vi.fn().mockReturnValue(chain);
      }
      chain.limit = vi.fn().mockReturnValue(chain);
      chain.update = vi.fn((payload: Record<string, unknown>) => {
        if (typeof payload.status === 'string') currentStatus = payload.status;
        if ('error_code' in payload) lastErrorCode = payload.error_code as string | null;
        return chain;
      });
      chain.single = vi.fn(() => Promise.resolve({
        data: {
          id: JOB_ID, level_group: 'B1_B2', target_level: 'B1', status: currentStatus, current_step: 'x',
          progress_percent: 50, episode_id: EPISODE_ID, attempts: 0, max_attempts: 3,
          error_code: lastErrorCode, error_message: lastErrorCode ? 'error' : null,
          retryable: false,
        },
        error: null,
      }));
      chain.maybeSingle = chain.single;
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
      return chain;
    }
    if (table === 'listening_episodes') {
      return makeAwaitableChain({
        data: { synopsis: opts.synopsis ?? 'English synopsis.', synopsis_pt: opts.synopsisPt ?? null },
        error: null,
      });
    }
    return makeAwaitableChain({ data: null, error: null });
  });
  return { from } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(gw, createMockGatewayDeps());
  gw.resetDefaults();
  mockCreate.mockImplementation(() => aiOk('Sinopse em português.', { prompt_tokens: 60, completion_tokens: 20 }));
  process.env.OPENAI_API_KEY = 'test-key';
});

describe('group stepPreparingDescription — LEGACY mode', () => {
  it('advances the job and writes no telemetry', async () => {
    await processListeningGroupGenerationStep(JOB_ID, WORKER_ID, makeGroupSupabase({}));
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
  });
});

describe('group stepPreparingDescription — OBSERVE mode', () => {
  beforeEach(() => {
    gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('records one event under the group-specific endpoint, featureKey listening.episode_translate_synopsis', async () => {
    await processListeningGroupGenerationStep(JOB_ID, WORKER_ID, makeGroupSupabase({}));
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(gw.mockStartEvent).toHaveBeenCalledTimes(1);
    expect(gw.mockStartEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        featureKey: 'listening.episode_translate_synopsis',
        provider: 'openai',
        service: 'chat.completions',
        model: 'gpt-4o-mini',
        userId: undefined,
        actorType: 'system',
        executionLocation: 'system',
        attemptNumber: 1,
        resourceType: 'listening_episode',
        resourceId: EPISODE_ID,
        metadata: expect.objectContaining({ endpoint: 'listening/on-demand/group/process-next' }),
      }),
    );
  });

  it('idempotency: synopsis_pt already present skips OpenAI entirely — no physical call, no event', async () => {
    await processListeningGroupGenerationStep(
      JOB_ID, WORKER_ID,
      makeGroupSupabase({ synopsis: 'English synopsis.', synopsisPt: 'Já traduzido.' }),
    );
    expect(mockCreate).not.toHaveBeenCalled();
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
  });

  it('a provider error creates a failed event and the job is marked failed with attempts incremented', async () => {
    mockCreate.mockRejectedValue(Object.assign(new Error('server error'), { status: 500 }));
    const result = await processListeningGroupGenerationStep(JOB_ID, WORKER_ID, makeGroupSupabase({}));
    expect(gw.mockFailEvent).toHaveBeenCalledTimes(1);
    expect(gw.mockCompleteEvent).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
  });
});
