import { describe, it, expect, vi } from 'vitest';
import { persistListeningStory, findListeningEpisodeByGenerationKey, StoryPersistError } from './persist-listening-story';
import type { ValidatedStory } from './listening-story-schema';

const IDEMPOTENCY_KEY = 'A1|||listening-story-v2|1';

function makeStory(): ValidatedStory {
  return {
    title: 'A Day at the Market',
    synopsis: 'A short story.',
    cefrLevel: 'A1',
    blocks: [
      { blockOrder: 1, textEn: 'Maria went to the market.', wordCount: 5, sentences: [] },
      { blockOrder: 2, textEn: 'She bought bread and milk.', wordCount: 5, sentences: [] },
    ],
  };
}

/**
 * Minimal chainable Supabase mock. `episodesTable` controls what
 * .from('listening_episodes') does for select/insert; other tables always
 * succeed with empty results (blocks/sentences inserts, episode update).
 */
function makeSupabase(opts: {
  insertResult: { data: unknown; error: unknown } | (() => { data: unknown; error: unknown });
  selectByKeyResult?: { data: unknown; error: unknown };
}) {
  const insertCalls: { table: string; rows: unknown }[] = [];
  let insertCallCount = 0;

  const from = vi.fn((table: string) => {
    if (table === 'listening_episodes') {
      return {
        insert: (rows: unknown) => {
          insertCalls.push({ table, rows });
          insertCallCount++;
          const result = typeof opts.insertResult === 'function' ? opts.insertResult() : opts.insertResult;
          return {
            select: () => ({
              single: async () => result,
            }),
          };
        },
        select: (_fields: string) => ({
          eq: (_col: string, _val: unknown) => ({
            maybeSingle: async () => opts.selectByKeyResult ?? { data: null, error: null },
          }),
        }),
        update: () => ({ eq: async () => ({ error: null }) }),
      };
    }
    if (table === 'listening_blocks') {
      return {
        insert: (rows: unknown) => {
          insertCalls.push({ table, rows });
          return {
            select: () => ({
              single: async () => ({ data: { id: `block-${insertCalls.length}` }, error: null }),
            }),
          };
        },
        update: () => ({ eq: async () => ({ error: null }) }),
      };
    }
    if (table === 'listening_sentences') {
      return {
        insert: async (rows: unknown) => {
          insertCalls.push({ table, rows });
          return { error: null };
        },
      };
    }
    return { insert: async () => ({ error: null }), select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
  });

  return { from, insertCalls, get insertCallCount() { return insertCallCount; } };
}

describe('findListeningEpisodeByGenerationKey', () => {
  it('returns null when no episode has this generation_key', async () => {
    const supabase = makeSupabase({ insertResult: { data: null, error: null }, selectByKeyResult: { data: null, error: null } });
    const result = await findListeningEpisodeByGenerationKey(supabase as any, IDEMPOTENCY_KEY);
    expect(result).toBeNull();
  });

  it('returns the existing episode when the generation_key matches', async () => {
    const supabase = makeSupabase({
      insertResult: { data: null, error: null },
      selectByKeyResult: { data: { id: 'ep-existing-1', status: 'content_ready', cefr_level: 'A1' }, error: null },
    });
    const result = await findListeningEpisodeByGenerationKey(supabase as any, IDEMPOTENCY_KEY);
    expect(result).toEqual({ id: 'ep-existing-1', status: 'content_ready', cefrLevel: 'A1' });
  });
});

describe('persistListeningStory — creation when generation_key does not yet exist', () => {
  it('inserts a fresh episode and its blocks/sentences', async () => {
    const supabase = makeSupabase({
      insertResult: { data: { id: 'ep-new-1' }, error: null },
    });
    const episodeId = await persistListeningStory(makeStory(), IDEMPOTENCY_KEY, supabase as any, null);
    expect(episodeId).toBe('ep-new-1');
    const blockInserts = supabase.insertCalls.filter(c => c.table === 'listening_blocks');
    expect(blockInserts).toHaveLength(2);
  });
});

describe('persistListeningStory — race on generation_key (23505)', () => {
  it('reuses the winning row instead of throwing, and does not insert a duplicate set of blocks', async () => {
    const supabase = makeSupabase({
      insertResult: {
        data: null,
        error: { code: '23505', message: 'duplicate key value violates unique constraint "listening_episodes_generation_key_key"' },
      },
      selectByKeyResult: { data: { id: 'ep-winner-1', status: 'content_ready', cefr_level: 'A1' }, error: null },
    });

    const episodeId = await persistListeningStory(makeStory(), IDEMPOTENCY_KEY, supabase as any, null);

    expect(episodeId).toBe('ep-winner-1');
    // No block/sentence rows inserted for the losing attempt.
    expect(supabase.insertCalls.filter(c => c.table === 'listening_blocks')).toHaveLength(0);
    expect(supabase.insertCalls.filter(c => c.table === 'listening_sentences')).toHaveLength(0);
  });

  it('throws StoryPersistError for a 23505 on a different constraint (not generation_key)', async () => {
    const supabase = makeSupabase({
      insertResult: {
        data: null,
        error: { code: '23505', message: 'duplicate key value violates unique constraint "some_other_constraint"' },
      },
    });
    await expect(
      persistListeningStory(makeStory(), IDEMPOTENCY_KEY, supabase as any, null)
    ).rejects.toThrow(StoryPersistError);
  });

  it('throws StoryPersistError when the 23505 race-recovery lookup itself finds nothing (should not happen, but must not silently proceed)', async () => {
    const supabase = makeSupabase({
      insertResult: {
        data: null,
        error: { code: '23505', message: 'duplicate key value violates unique constraint "listening_episodes_generation_key_key"' },
      },
      selectByKeyResult: { data: null, error: null },
    });
    await expect(
      persistListeningStory(makeStory(), IDEMPOTENCY_KEY, supabase as any, null)
    ).rejects.toThrow(StoryPersistError);
  });

  it('a non-conflict DB error still throws StoryPersistError unchanged', async () => {
    const supabase = makeSupabase({
      insertResult: { data: null, error: { code: '42501', message: 'permission denied' } },
    });
    await expect(
      persistListeningStory(makeStory(), IDEMPOTENCY_KEY, supabase as any, null)
    ).rejects.toThrow(StoryPersistError);
  });
});
