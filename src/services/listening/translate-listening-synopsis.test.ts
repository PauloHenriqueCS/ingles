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

import { translateListeningSynopsis } from './translate-listening-synopsis';

const EPISODE_ID = 'eeeeeeee-0000-0000-0000-000000000001';

function makeSupabase(episode: { synopsis: string | null; synopsis_pt: string | null } | null) {
  const update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) });
  const from = vi.fn((table: string) => {
    if (table === 'listening_episodes') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: episode, error: null }),
          }),
        }),
        update,
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });
  return { from, update } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(gw, createMockGatewayDeps());
  gw.resetDefaults();
  mockCreate.mockImplementation(() => aiOk('Sinopse em português.', { prompt_tokens: 60, completion_tokens: 20 }));
  process.env.OPENAI_API_KEY = 'test-key';
});

describe('translateListeningSynopsis', () => {
  it('translates and persists synopsis_pt when missing', async () => {
    const supabase = makeSupabase({ synopsis: 'English synopsis.', synopsis_pt: null });
    const result = await translateListeningSynopsis(
      { episodeId: EPISODE_ID, endpoint: 'listening/on-demand/process-next' },
      supabase,
    );
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ translated: true, synopsisPt: 'Sinopse em português.' });
    expect(supabase.update).toHaveBeenCalledWith(
      expect.objectContaining({ synopsis_pt: 'Sinopse em português.' }),
    );
  });

  it('is idempotent: skips the AI call entirely when synopsis_pt is already set', async () => {
    const supabase = makeSupabase({ synopsis: 'English synopsis.', synopsis_pt: 'Já traduzido.' });
    const result = await translateListeningSynopsis(
      { episodeId: EPISODE_ID, endpoint: 'listening/on-demand/process-next' },
      supabase,
    );
    expect(mockCreate).not.toHaveBeenCalled();
    expect(supabase.update).not.toHaveBeenCalled();
    expect(result).toEqual({ translated: false, synopsisPt: 'Já traduzido.' });
  });

  it('skips when there is no English synopsis yet', async () => {
    const supabase = makeSupabase({ synopsis: null, synopsis_pt: null });
    const result = await translateListeningSynopsis(
      { episodeId: EPISODE_ID, endpoint: 'listening/on-demand/process-next' },
      supabase,
    );
    expect(mockCreate).not.toHaveBeenCalled();
    expect(result).toEqual({ translated: false, synopsisPt: null });
  });

  it('uses the AI Gateway with the listening.episode_translate_synopsis feature key', async () => {
    gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
    const supabase = makeSupabase({ synopsis: 'English synopsis.', synopsis_pt: null });
    await translateListeningSynopsis(
      { episodeId: EPISODE_ID, endpoint: 'listening/on-demand/group/process-next' },
      supabase,
    );
    expect(gw.mockStartEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        featureKey: 'listening.episode_translate_synopsis',
        provider: 'openai',
        service: 'chat.completions',
        model: 'gpt-4o-mini',
        actorType: 'system',
        executionLocation: 'system',
        resourceType: 'listening_episode',
        resourceId: EPISODE_ID,
      }),
    );
  });

  it('propagates provider errors without persisting a partial translation', async () => {
    mockCreate.mockRejectedValue(Object.assign(new Error('server error'), { status: 500 }));
    const supabase = makeSupabase({ synopsis: 'English synopsis.', synopsis_pt: null });
    await expect(
      translateListeningSynopsis(
        { episodeId: EPISODE_ID, endpoint: 'listening/on-demand/process-next' },
        supabase,
      ),
    ).rejects.toThrow();
    expect(supabase.update).not.toHaveBeenCalled();
  });

  it('is called identically (same feature key, same idempotency behavior) regardless of caller pipeline', async () => {
    const supabaseOnDemand = makeSupabase({ synopsis: 'A story.', synopsis_pt: null });
    const supabaseGroup = makeSupabase({ synopsis: 'A story.', synopsis_pt: null });
    await translateListeningSynopsis({ episodeId: EPISODE_ID, endpoint: 'listening/on-demand/process-next' }, supabaseOnDemand);
    await translateListeningSynopsis({ episodeId: EPISODE_ID, endpoint: 'listening/on-demand/group/process-next' }, supabaseGroup);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(supabaseOnDemand.update).toHaveBeenCalledTimes(1);
    expect(supabaseGroup.update).toHaveBeenCalledTimes(1);
  });
});
