import { describe, it, expect, vi } from 'vitest';
import { findReusableListeningGroupStory } from './find-reusable-listening-group-story';

function makeSupabase(data: { id: string } | null, errorMsg?: string) {
  const eqCalls: unknown[][] = [];
  const chain: any = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn((...args: unknown[]) => { eqCalls.push(args); return chain; });
  chain.order = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.maybeSingle = vi.fn().mockResolvedValue(
    errorMsg ? { data: null, error: { message: errorMsg } } : { data, error: null },
  );
  const from = vi.fn().mockReturnValue(chain);
  return { from, eqCalls } as any;
}

describe('findReusableListeningGroupStory', () => {
  it('returns the published episode id when a reusable story exists', async () => {
    const supabase = makeSupabase({ id: 'episode-1' });
    const result = await findReusableListeningGroupStory(supabase, 'A1_A2', 'A1');
    expect(result).toEqual({ episodeId: 'episode-1' });
  });

  it('returns null when no published story exists for the target level yet', async () => {
    const supabase = makeSupabase(null);
    const result = await findReusableListeningGroupStory(supabase, 'A1_A2', 'A2');
    expect(result).toBeNull();
  });

  it('filters by level_group, cefr_level (target level), and published status', async () => {
    const supabase = makeSupabase({ id: 'episode-1' });
    await findReusableListeningGroupStory(supabase, 'B1_B2', 'B2');
    expect(supabase.eqCalls).toEqual(
      expect.arrayContaining([
        ['level_group', 'B1_B2'],
        ['cefr_level', 'B2'],
        ['status', 'published'],
      ]),
    );
  });

  it('propagates database errors', async () => {
    const supabase = makeSupabase(null, 'db down');
    await expect(findReusableListeningGroupStory(supabase, 'A1_A2', 'A1')).rejects.toThrow('db down');
  });
});
