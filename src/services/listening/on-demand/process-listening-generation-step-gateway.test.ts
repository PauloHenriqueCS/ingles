/**
 * Integration tests for process-listening-generation-step.ts (stepPreparingDescription) —
 * AI Gateway integration (Etapa 8D), featureKey listening.episode_translate_synopsis.
 *
 * Only the physical openai.chat.completions.create(...) call is wrapped. This
 * feature has no requireAuth-validated userId available at the call site (the
 * step function only receives episode_id, not user identity), so it is
 * recorded as actorType 'system' with userId undefined — proven below.
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

import { processListeningGenerationStep } from './process-listening-generation-step';

const SESSION_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
const EPISODE_ID = 'cccccccc-0000-0000-0000-000000000001';
const USER_ID = 'dddddddd-0000-0000-0000-000000000001';

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
 * Stateful stub for user_listening_generation_sessions: tracks whatever
 * `.update({ status, ... })` payload was last written (advanceSession on
 * success, failSession on error) so the final `.single()` fetch reflects the
 * real outcome instead of a hardcoded status.
 */
function makeOnDemandSupabase(opts: { synopsis?: string | null; synopsisPt?: string | null }) {
  let sessionsCall = 0;
  let currentStatus = 'preparing_description';
  let lastErrorCode: string | null = null;

  const from = vi.fn((table: string) => {
    if (table === 'user_listening_generation_sessions') {
      sessionsCall += 1;
      if (sessionsCall === 1) {
        // acquireLock: update(...).eq(...).eq(...).or(...).select(...).maybeSingle()
        return makeAwaitableChain({
          data: {
            id: SESSION_ID, status: currentStatus,
            user_level: 'B1', episode_id: EPISODE_ID, local_date: '2026-07-17',
          },
          error: null,
        });
      }
      // advanceSession / failSession: update({status, error_code, ...}).eq('id', sessionId)
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
          id: SESSION_ID, status: currentStatus, current_step: 'x',
          progress_percent: 50, episode_id: EPISODE_ID,
          error_code: lastErrorCode, error_message: lastErrorCode ? 'error' : null,
          retryable: false,
        },
        error: null,
      }));
      chain.maybeSingle = chain.single;
      // advanceSession/failSession await the chain directly after .eq(...) without
      // calling .single() — make the chain itself thenable so that resolves too.
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

describe('stepPreparingDescription — LEGACY mode', () => {
  it('advances the session and writes no telemetry', async () => {
    const result = await processListeningGenerationStep(SESSION_ID, USER_ID, makeOnDemandSupabase({}));
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
  });
});

describe('stepPreparingDescription — OBSERVE mode', () => {
  beforeEach(() => {
    gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('records one event: featureKey listening.episode_translate_synopsis, actorType system, userId undefined', async () => {
    await processListeningGenerationStep(SESSION_ID, USER_ID, makeOnDemandSupabase({}));
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
      }),
    );
  });

  it('idempotency: synopsis_pt already present skips OpenAI entirely — no physical call, no event', async () => {
    await processListeningGenerationStep(
      SESSION_ID, USER_ID,
      makeOnDemandSupabase({ synopsis: 'English synopsis.', synopsisPt: 'Já traduzido.' }),
    );
    expect(mockCreate).not.toHaveBeenCalled();
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
  });

  it('a provider error creates a failed event and the session is marked failed (existing behavior preserved)', async () => {
    mockCreate.mockRejectedValue(Object.assign(new Error('server error'), { status: 500 }));
    const result = await processListeningGenerationStep(SESSION_ID, USER_ID, makeOnDemandSupabase({}));
    expect(gw.mockFailEvent).toHaveBeenCalledTimes(1);
    expect(gw.mockCompleteEvent).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
  });

  it('metadata contains no synopsis content', async () => {
    await processListeningGenerationStep(SESSION_ID, USER_ID, makeOnDemandSupabase({ synopsis: 'Very secret confidential synopsis text.' }));
    const startCall = gw.mockStartEvent.mock.calls[0][0] as any;
    const metadataStr = JSON.stringify(startCall.metadata);
    expect(metadataStr).not.toContain('secret');
    expect(metadataStr).not.toContain('confidential');
    expect(Object.keys(startCall.metadata).sort()).toEqual(['endpoint', 'flowType'].sort());
  });

  it('a telemetry failure (startEvent) does not break the step', async () => {
    gw.mockStartEvent.mockRejectedValue(new Error('DB down'));
    const result = await processListeningGenerationStep(SESSION_ID, USER_ID, makeOnDemandSupabase({}));
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(result.status).not.toBe('failed');
  });
});
