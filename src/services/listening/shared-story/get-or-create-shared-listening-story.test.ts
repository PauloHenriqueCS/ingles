import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SharedStoryGeneratingError } from './listening-shared-story-types';

// This file mocks the acquire_or_get_listening_shared_story RPC — it can
// only prove the orchestrator's REACTION to won/status (see the "reuse"
// and "expired-lock takeover" describe blocks below), not the RPC's own
// SQL reacquire condition. That condition (a 'ready' row is never taken
// over by an expired lock; a 'generating' row is takeable over only when
// its own lock has expired; a 'failed' row is always takeable over) is
// proven against a real Postgres instance by the inline validation block
// in supabase/migrations/20260724070000_fix_listening_shared_story_reacquire_and_grants.sql
// (run automatically on every migration apply — RAISE EXCEPTION aborts
// the migration on any mismatch).

vi.mock('../daily/resolve-user-listening-level', () => ({
  resolveUserListeningLevel: vi.fn(),
}));
vi.mock('../daily/resolve-listening-activity-date', () => ({
  resolveListeningActivityDate: vi.fn(),
}));
vi.mock('../story-session/generate-listening-story', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../story-session/generate-listening-story')>();
  return { ...actual, generateListeningStory: vi.fn() };
});

import { getOrCreateSharedListeningStory, getPendingListeningStoryForToday } from './get-or-create-shared-listening-story';
import { resolveUserListeningLevel } from '../daily/resolve-user-listening-level';
import { resolveListeningActivityDate } from '../daily/resolve-listening-activity-date';
import { generateListeningStory } from '../story-session/generate-listening-story';
import type { ListeningStoryResult } from '../story-session/generate-listening-story';

const OPENAI_KEY = 'oa-key';
const AZURE_KEY = 'az-key';
const AZURE_REGION = 'eastus';
const SECRET = 'test-secret';
const PRACTICE_DATE = '2026-07-24';

function makeStoryResult(overrides: Partial<ListeningStoryResult> = {}): ListeningStoryResult {
  return {
    title: 'A Trip',
    level: 'A1',
    summary: 'Summary.',
    parts: [
      {
        id: 1, text: 'Part one text.',
        audioBase64: Buffer.from('audio-bytes-part-1').toString('base64'), audioMimeType: 'audio/mpeg',
        question: { prompt: 'Q1?', options: ['a', 'b', 'c', 'd', 'e'], correctOptionIndex: 2, explanationPt: 'Exp1' },
        answerToken: 'original-token-1',
      },
      {
        id: 2, text: 'Part two text.',
        audioBase64: Buffer.from('audio-bytes-part-2').toString('base64'), audioMimeType: 'audio/mpeg',
        question: { prompt: 'Q2?', options: ['a', 'b', 'c', 'd', 'e'], correctOptionIndex: 1, explanationPt: 'Exp2' },
        answerToken: 'original-token-2',
      },
    ],
    ...overrides,
  };
}

interface RpcRow {
  id: string; status: 'generating' | 'ready' | 'failed'; won: boolean;
  content: unknown; part1_audio_path: string | null; part2_audio_path: string | null;
  audio_mime_type: string | null; error_message: string | null;
}

// opts.pending drives the new step-0 pending-recovery path (findPendingStory):
// null → no pending (the default; runs the acquire/generate flow as before).
function makeMockDb(
  rpcRow: RpcRow,
  opts: { pending?: { storyId: string; status: 'ready' | 'generating' | 'failed'; lockExpiresAt?: string | null } | null } = {},
) {
  const rpcMock = vi.fn(async () => ({ data: [rpcRow], error: null }));
  const updateSharedStoryMock = vi.fn(async () => ({ error: null }));
  const upsertProgressMock = vi.fn(async () => ({ error: null }));
  const deleteProgressMock = vi.fn(() => ({ error: null }));
  const uploadMock = vi.fn(async () => ({ error: null }));
  const downloadMock = vi.fn(async (path: string) => ({
    data: { arrayBuffer: async () => new TextEncoder().encode(`downloaded:${path}`).buffer },
    error: null,
  }));

  const pending = opts.pending ?? null;
  const pendingProgressRow = pending ? { shared_story_id: pending.storyId } : null;
  const ready = pending?.status === 'ready';
  const pendingStoryRow = pending
    ? {
        id: pending.storyId,
        status: pending.status,
        content: ready
          ? { title: 'Pending Story', level: 'A1', summary: 'Pending summary.', parts: [
              { id: 1, text: 'PP1.', question: { prompt: 'PQ1?', options: ['a', 'b', 'c', 'd', 'e'], correctOptionIndex: 0, explanationPt: 'PE1' } },
              { id: 2, text: 'PP2.', question: { prompt: 'PQ2?', options: ['a', 'b', 'c', 'd', 'e'], correctOptionIndex: 1, explanationPt: 'PE2' } },
            ] }
          : null,
        part1_audio_path: ready ? 'shared/A1_A2/pending/part1.mp3' : null,
        part2_audio_path: ready ? 'shared/A1_A2/pending/part2.mp3' : null,
        audio_mime_type: ready ? 'audio/mpeg' : null,
        lock_expires_at: pending?.lockExpiresAt ?? null,
      }
    : null;

  const client = {
    rpc: rpcMock,
    from: (table: string) => {
      if (table === 'listening_shared_stories') {
        return {
          update: (patch: Record<string, unknown>) => ({ eq: (_col: string, val: unknown) => updateSharedStoryMock(patch, val) }),
          // findPendingStory step 2: fetch the pending progress row's story.
          select: () => { const c: any = { eq: () => c, maybeSingle: async () => ({ data: pendingStoryRow, error: null }) }; return c; },
        };
      }
      if (table === 'user_listening_shared_progress') {
        return {
          // findPendingStory step 1: the user's completed=false row for today.
          select: () => { const c: any = { eq: () => c, maybeSingle: async () => ({ data: pendingProgressRow, error: null }) }; return c; },
          upsert: (row: Record<string, unknown>, o: Record<string, unknown>) => upsertProgressMock(row, o),
          delete: () => { const c: any = { eq: () => c, then: (res: (v: unknown) => unknown) => { deleteProgressMock(); return res({ error: null }); } }; return c; },
        };
      }
      throw new Error(`Unexpected table in mock: ${table}`);
    },
    storage: {
      from: (bucket: string) => ({
        upload: (path: string, bytes: unknown, o: unknown) => uploadMock(bucket, path, bytes, o),
        download: (path: string) => downloadMock(path),
      }),
    },
  };

  return { client: client as any, rpcMock, updateSharedStoryMock, upsertProgressMock, deleteProgressMock, uploadMock, downloadMock };
}

function wonRow(overrides: Partial<RpcRow> = {}): RpcRow {
  return { id: 'story-1', status: 'generating', won: true, content: null, part1_audio_path: null, part2_audio_path: null, audio_mime_type: null, error_message: null, ...overrides };
}

function readyRow(overrides: Partial<RpcRow> = {}): RpcRow {
  return {
    id: 'story-1', status: 'ready', won: false,
    content: {
      title: 'Cached Story', level: 'A1', summary: 'Cached summary.',
      parts: [
        { id: 1, text: 'Cached part 1.', question: { prompt: 'CQ1?', options: ['a', 'b', 'c', 'd', 'e'], correctOptionIndex: 0, explanationPt: 'CExp1' } },
        { id: 2, text: 'Cached part 2.', question: { prompt: 'CQ2?', options: ['a', 'b', 'c', 'd', 'e'], correctOptionIndex: 3, explanationPt: 'CExp2' } },
      ],
    },
    part1_audio_path: 'shared/A1_A2/story-1/part1.mp3',
    part2_audio_path: 'shared/A1_A2/story-1/part2.mp3',
    audio_mime_type: 'audio/mpeg',
    error_message: null,
    ...overrides,
  };
}

function generatingRow(overrides: Partial<RpcRow> = {}): RpcRow {
  return { id: 'story-1', status: 'generating', won: false, content: null, part1_audio_path: null, part2_audio_path: null, audio_mime_type: null, error_message: null, ...overrides };
}

beforeEach(() => {
  vi.mocked(resolveListeningActivityDate).mockReturnValue(PRACTICE_DATE);
  vi.mocked(generateListeningStory).mockReset();
});

describe('getOrCreateSharedListeningStory — level group mapping (1-3)', () => {
  it.each([
    ['A1', 'A1_A2'], ['A2', 'A1_A2'],
    ['B1', 'B1_B2'], ['B2', 'B1_B2'],
    ['C1', 'C1_C2'], ['C2', 'C1_C2'],
  ] as const)('%s maps to %s', async (cefrLevel, expectedGroup) => {
    vi.mocked(resolveUserListeningLevel).mockResolvedValue(cefrLevel);
    vi.mocked(generateListeningStory).mockResolvedValue(makeStoryResult({ level: cefrLevel }));
    const db = makeMockDb(wonRow());

    await getOrCreateSharedListeningStory('user-1', db.client, OPENAI_KEY, AZURE_KEY, AZURE_REGION, SECRET);

    expect(db.rpcMock).toHaveBeenCalledWith(
      'acquire_or_get_listening_shared_story',
      expect.objectContaining({ p_level_group: expectedGroup, p_target_level: cefrLevel, p_practice_date: PRACTICE_DATE }),
    );
  });
});

describe('getOrCreateSharedListeningStory — reuse (4, 5, 6, 16)', () => {
  it('4. a ready shared story is reused instead of generating a new one', async () => {
    vi.mocked(resolveUserListeningLevel).mockResolvedValue('A1');
    const db = makeMockDb(readyRow());

    const result = await getOrCreateSharedListeningStory('user-1', db.client, OPENAI_KEY, AZURE_KEY, AZURE_REGION, SECRET);

    expect(result.title).toBe('Cached Story');
    expect(result.parts[0].text).toBe('Cached part 1.');
  });

  it('5/6. reuse makes zero OpenAI and zero Azure calls (generateListeningStory, the only place either is called, is never invoked)', async () => {
    vi.mocked(resolveUserListeningLevel).mockResolvedValue('A1');
    const db = makeMockDb(readyRow());

    await getOrCreateSharedListeningStory('user-1', db.client, OPENAI_KEY, AZURE_KEY, AZURE_REGION, SECRET);

    expect(generateListeningStory).not.toHaveBeenCalled();
  });

  it('6. two separate opens of the same ready story (e.g. minutes apart) each reuse it — zero OpenAI/Azure calls across both', async () => {
    // Simulates two independent requests hitting an already-ready row well
    // after its original lock would have expired: the RPC (mocked here;
    // its own reacquire condition is proven against real Postgres in
    // supabase/migrations/20260724070000_fix_listening_shared_story_reacquire_and_grants.sql)
    // keeps returning status='ready', won=false for both, so neither
    // request may call the old flow.
    vi.mocked(resolveUserListeningLevel).mockResolvedValue('A1');
    const db = makeMockDb(readyRow());

    await getOrCreateSharedListeningStory('user-a', db.client, OPENAI_KEY, AZURE_KEY, AZURE_REGION, SECRET);
    await getOrCreateSharedListeningStory('user-b', db.client, OPENAI_KEY, AZURE_KEY, AZURE_REGION, SECRET);

    expect(generateListeningStory).not.toHaveBeenCalled();
    expect(db.rpcMock).toHaveBeenCalledTimes(2);
  });

  it('16. a reused response keeps the exact ListeningStoryData contract the frontend expects', async () => {
    vi.mocked(resolveUserListeningLevel).mockResolvedValue('A1');
    const db = makeMockDb(readyRow());

    const result = await getOrCreateSharedListeningStory('user-1', db.client, OPENAI_KEY, AZURE_KEY, AZURE_REGION, SECRET);

    expect(result).toMatchObject({
      title: expect.any(String),
      level: expect.any(String),
      summary: expect.any(String),
    });
    expect(result.parts).toHaveLength(2);
    for (const part of result.parts) {
      expect(part).toMatchObject({
        id: expect.any(Number),
        text: expect.any(String),
        audioBase64: expect.any(String),
        audioMimeType: 'audio/mpeg',
        question: {
          prompt: expect.any(String),
          options: expect.any(Array),
          correctOptionIndex: expect.any(Number),
          explanationPt: expect.any(String),
        },
        answerToken: expect.any(String),
      });
      expect(part.question.options).toHaveLength(5);
    }
    // Tokens are re-signed fresh on every serve, never the stale ones from generation time.
    expect(result.parts[0].answerToken).not.toBe('original-token-1');
  });

  it('7. downloads audio from Storage using the exact stored paths, base64-encoding it for the response — never re-uploads/overwrites existing audio', async () => {
    vi.mocked(resolveUserListeningLevel).mockResolvedValue('A1');
    const db = makeMockDb(readyRow());

    await getOrCreateSharedListeningStory('user-1', db.client, OPENAI_KEY, AZURE_KEY, AZURE_REGION, SECRET);

    expect(db.downloadMock).toHaveBeenCalledWith('shared/A1_A2/story-1/part1.mp3');
    expect(db.downloadMock).toHaveBeenCalledWith('shared/A1_A2/story-1/part2.mp3');
    expect(db.uploadMock).not.toHaveBeenCalled();
  });
});

describe('getOrCreateSharedListeningStory — absence of a ready story runs the old flow (7, 8, 9, 15)', () => {
  it('7. no shared story exists -> runs exactly the existing generateListeningStory flow, unmodified args', async () => {
    vi.mocked(resolveUserListeningLevel).mockResolvedValue('A1');
    vi.mocked(generateListeningStory).mockResolvedValue(makeStoryResult());
    const db = makeMockDb(wonRow());

    await getOrCreateSharedListeningStory('user-1', db.client, OPENAI_KEY, AZURE_KEY, AZURE_REGION, SECRET, 'pkg', 'travel');

    expect(generateListeningStory).toHaveBeenCalledWith(
      'user-1', db.client, OPENAI_KEY, AZURE_KEY, AZURE_REGION, SECRET, 'pkg', 'travel',
    );
  });

  it('8. the old flow\'s result is saved (status=ready, content, audio paths)', async () => {
    vi.mocked(resolveUserListeningLevel).mockResolvedValue('A1');
    vi.mocked(generateListeningStory).mockResolvedValue(makeStoryResult());
    const db = makeMockDb(wonRow());

    await getOrCreateSharedListeningStory('user-1', db.client, OPENAI_KEY, AZURE_KEY, AZURE_REGION, SECRET);

    expect(db.updateSharedStoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'ready',
        content: expect.objectContaining({ title: 'A Trip', level: 'A1', summary: 'Summary.' }),
        part1_audio_path: expect.stringContaining('story-1'),
        part2_audio_path: expect.stringContaining('story-1'),
        audio_mime_type: 'audio/mpeg',
      }),
      'story-1',
    );
  });

  it('a successful persist clears lock_expires_at (defense in depth — a ready row should never carry a stale lock)', async () => {
    vi.mocked(resolveUserListeningLevel).mockResolvedValue('A1');
    vi.mocked(generateListeningStory).mockResolvedValue(makeStoryResult());
    const db = makeMockDb(wonRow());

    await getOrCreateSharedListeningStory('user-1', db.client, OPENAI_KEY, AZURE_KEY, AZURE_REGION, SECRET);

    expect(db.updateSharedStoryMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ready', lock_expires_at: null }),
      'story-1',
    );
  });

  it('9. audio is uploaded exactly once per part (2 calls total), never on reuse', async () => {
    vi.mocked(resolveUserListeningLevel).mockResolvedValue('A1');
    vi.mocked(generateListeningStory).mockResolvedValue(makeStoryResult());
    const db = makeMockDb(wonRow());

    await getOrCreateSharedListeningStory('user-1', db.client, OPENAI_KEY, AZURE_KEY, AZURE_REGION, SECRET);

    expect(db.uploadMock).toHaveBeenCalledTimes(2);
    expect(db.uploadMock).toHaveBeenCalledWith('listening-audio', 'shared/A1_A2/story-1/part1.mp3', expect.anything(), expect.objectContaining({ upsert: true }));
    expect(db.uploadMock).toHaveBeenCalledWith('listening-audio', 'shared/A1_A2/story-1/part2.mp3', expect.anything(), expect.objectContaining({ upsert: true }));
  });

  it('15. the persisted shared content never contains user_id', async () => {
    vi.mocked(resolveUserListeningLevel).mockResolvedValue('A1');
    vi.mocked(generateListeningStory).mockResolvedValue(makeStoryResult());
    const db = makeMockDb(wonRow());

    await getOrCreateSharedListeningStory('user-1', db.client, OPENAI_KEY, AZURE_KEY, AZURE_REGION, SECRET);

    const [patch] = db.updateSharedStoryMock.mock.calls[0];
    expect(JSON.stringify(patch)).not.toContain('user_id');
    expect(JSON.stringify(patch.content)).not.toContain('user-1');
  });

  it('the audio path is deterministic — no user_id, playback rate, attempt, or timestamp segment', async () => {
    vi.mocked(resolveUserListeningLevel).mockResolvedValue('A1');
    vi.mocked(generateListeningStory).mockResolvedValue(makeStoryResult());
    const db = makeMockDb(wonRow());

    await getOrCreateSharedListeningStory('user-42', db.client, OPENAI_KEY, AZURE_KEY, AZURE_REGION, SECRET);

    const paths = db.uploadMock.mock.calls.map(call => call[1] as string);
    for (const path of paths) {
      expect(path).toBe(`shared/A1_A2/story-1/part${paths.indexOf(path) + 1}.mp3`);
      expect(path).not.toContain('user-42');
    }
  });
});

describe('getOrCreateSharedListeningStory — concurrency (10, 11)', () => {
  it('10/11. a live lock held by another request never calls OpenAI/Azure and surfaces a simple, existing-contract error', async () => {
    vi.mocked(resolveUserListeningLevel).mockResolvedValue('A1');
    const db = makeMockDb(generatingRow());

    await expect(
      getOrCreateSharedListeningStory('user-2', db.client, OPENAI_KEY, AZURE_KEY, AZURE_REGION, SECRET),
    ).rejects.toBeInstanceOf(SharedStoryGeneratingError);

    expect(generateListeningStory).not.toHaveBeenCalled();
  });

  it('the winner of the lock is the only one that calls generateListeningStory', async () => {
    vi.mocked(resolveUserListeningLevel).mockResolvedValue('A1');
    vi.mocked(generateListeningStory).mockResolvedValue(makeStoryResult());
    const winnerDb = makeMockDb(wonRow());
    const loserDb = makeMockDb(generatingRow());

    await getOrCreateSharedListeningStory('user-1', winnerDb.client, OPENAI_KEY, AZURE_KEY, AZURE_REGION, SECRET);
    await expect(
      getOrCreateSharedListeningStory('user-2', loserDb.client, OPENAI_KEY, AZURE_KEY, AZURE_REGION, SECRET),
    ).rejects.toBeInstanceOf(SharedStoryGeneratingError);

    expect(generateListeningStory).toHaveBeenCalledTimes(1);
  });
});

describe('getOrCreateSharedListeningStory — expired-lock takeover (12)', () => {
  it('12. won=true is treated identically whether from a fresh row or a takeover of an expired/failed lock — the RPC alone decides which; the orchestrator just proceeds to generate', async () => {
    // The distinction between "fresh insert" and "took over a failed/expired
    // lock" lives entirely in acquire_or_get_listening_shared_story's SQL
    // (see the migration) — from the orchestrator's perspective both cases
    // are indistinguishable and handled identically (won=true -> generate).
    vi.mocked(resolveUserListeningLevel).mockResolvedValue('A1');
    vi.mocked(generateListeningStory).mockResolvedValue(makeStoryResult());
    const db = makeMockDb(wonRow({ id: 'story-retaken' }));

    const result = await getOrCreateSharedListeningStory('user-3', db.client, OPENAI_KEY, AZURE_KEY, AZURE_REGION, SECRET);

    expect(generateListeningStory).toHaveBeenCalledTimes(1);
    expect(result.title).toBe('A Trip');
    expect(db.updateSharedStoryMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'ready' }), 'story-retaken');
  });
});

describe('getOrCreateSharedListeningStory — failure handling (13)', () => {
  it('13. a failure in the old flow marks the row failed and re-throws the original error', async () => {
    vi.mocked(resolveUserListeningLevel).mockResolvedValue('A1');
    const originalError = new Error('AI_INVALID_JSON');
    vi.mocked(generateListeningStory).mockRejectedValue(originalError);
    const db = makeMockDb(wonRow());

    await expect(
      getOrCreateSharedListeningStory('user-1', db.client, OPENAI_KEY, AZURE_KEY, AZURE_REGION, SECRET),
    ).rejects.toBe(originalError);

    expect(db.updateSharedStoryMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error_message: expect.stringContaining('AI_INVALID_JSON') }),
      'story-1',
    );
    expect(db.uploadMock).not.toHaveBeenCalled(); // never persisted audio for a failed generation
  });

  it('a persist (Storage upload) failure after a successful generation still marks the row failed', async () => {
    vi.mocked(resolveUserListeningLevel).mockResolvedValue('A1');
    vi.mocked(generateListeningStory).mockResolvedValue(makeStoryResult());
    const db = makeMockDb(wonRow());
    db.uploadMock.mockResolvedValueOnce({ error: { message: 'storage down' } });

    await expect(
      getOrCreateSharedListeningStory('user-1', db.client, OPENAI_KEY, AZURE_KEY, AZURE_REGION, SECRET),
    ).rejects.toThrow(/SHARED_STORY_AUDIO_UPLOAD_FAILED/);

    expect(db.updateSharedStoryMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
      'story-1',
    );
  });
});

describe('getOrCreateSharedListeningStory — per-user progress (14)', () => {
  it('14. two different users each get their own progress row against the same shared story', async () => {
    vi.mocked(resolveUserListeningLevel).mockResolvedValue('A1');
    const db = makeMockDb(readyRow());

    await getOrCreateSharedListeningStory('user-a', db.client, OPENAI_KEY, AZURE_KEY, AZURE_REGION, SECRET);
    await getOrCreateSharedListeningStory('user-b', db.client, OPENAI_KEY, AZURE_KEY, AZURE_REGION, SECRET);

    expect(db.upsertProgressMock).toHaveBeenCalledWith(
      { user_id: 'user-a', shared_story_id: 'story-1', activity_date: PRACTICE_DATE },
      expect.objectContaining({ onConflict: 'user_id,shared_story_id' }),
    );
    expect(db.upsertProgressMock).toHaveBeenCalledWith(
      { user_id: 'user-b', shared_story_id: 'story-1', activity_date: PRACTICE_DATE },
      expect.objectContaining({ onConflict: 'user_id,shared_story_id' }),
    );
    expect(db.upsertProgressMock).toHaveBeenCalledTimes(2);
  });

  it('the winner of a fresh generation also gets a PENDING progress row (completed=false, tagged with activity_date)', async () => {
    vi.mocked(resolveUserListeningLevel).mockResolvedValue('A1');
    vi.mocked(generateListeningStory).mockResolvedValue(makeStoryResult());
    const db = makeMockDb(wonRow());

    await getOrCreateSharedListeningStory('user-winner', db.client, OPENAI_KEY, AZURE_KEY, AZURE_REGION, SECRET);

    expect(db.upsertProgressMock).toHaveBeenCalledWith(
      { user_id: 'user-winner', shared_story_id: 'story-1', activity_date: PRACTICE_DATE },
      expect.objectContaining({ onConflict: 'user_id,shared_story_id' }),
    );
    // Preparing never writes completed — that only happens on practice.
    const [row] = db.upsertProgressMock.mock.calls[0];
    expect(row).not.toHaveProperty('completed');
  });
});

describe('getOrCreateSharedListeningStory — pending recovery (prepared ≠ consumed)', () => {
  it('a READY pending story is returned as-is: same story, no acquire RPC, no generation, no new attach', async () => {
    vi.mocked(resolveUserListeningLevel).mockResolvedValue('A1');
    // rpcRow would advance to a different story if it were ever called.
    const db = makeMockDb(wonRow({ id: 'different-story' }), { pending: { storyId: 'pending-1', status: 'ready' } });

    const result = await getOrCreateSharedListeningStory('user-1', db.client, OPENAI_KEY, AZURE_KEY, AZURE_REGION, SECRET);

    expect(result.title).toBe('Pending Story');
    expect(result.sharedStoryId).toBe('pending-1');
    expect(db.rpcMock).not.toHaveBeenCalled();          // never selects/advances a new story
    expect(generateListeningStory).not.toHaveBeenCalled();
    expect(db.upsertProgressMock).not.toHaveBeenCalled(); // the pending row already exists
    expect(db.downloadMock).toHaveBeenCalledWith('shared/A1_A2/pending/part1.mp3');
  });

  it('a still-GENERATING pending (lock not expired) surfaces SharedStoryGeneratingError, never advances', async () => {
    vi.mocked(resolveUserListeningLevel).mockResolvedValue('A1');
    const future = new Date(Date.now() + 60_000).toISOString();
    const db = makeMockDb(wonRow(), { pending: { storyId: 'pending-1', status: 'generating', lockExpiresAt: future } });

    await expect(
      getOrCreateSharedListeningStory('user-1', db.client, OPENAI_KEY, AZURE_KEY, AZURE_REGION, SECRET),
    ).rejects.toBeInstanceOf(SharedStoryGeneratingError);
    expect(db.rpcMock).not.toHaveBeenCalled();
    expect(generateListeningStory).not.toHaveBeenCalled();
  });

  it('a FAILED pending is dropped, then a fresh story is prepared (falls through to acquire + generate)', async () => {
    vi.mocked(resolveUserListeningLevel).mockResolvedValue('A1');
    vi.mocked(generateListeningStory).mockResolvedValue(makeStoryResult());
    const db = makeMockDb(wonRow({ id: 'fresh-1' }), { pending: { storyId: 'stale-1', status: 'failed' } });

    const result = await getOrCreateSharedListeningStory('user-1', db.client, OPENAI_KEY, AZURE_KEY, AZURE_REGION, SECRET);

    expect(db.deleteProgressMock).toHaveBeenCalledTimes(1); // stale pending dropped
    expect(db.rpcMock).toHaveBeenCalledTimes(1);            // fresh selection
    expect(generateListeningStory).toHaveBeenCalledTimes(1);
    expect(result.sharedStoryId).toBe('fresh-1');
  });

  it('an EXPIRED generating pending is treated as stale (dropped, fresh prepared)', async () => {
    vi.mocked(resolveUserListeningLevel).mockResolvedValue('A1');
    vi.mocked(generateListeningStory).mockResolvedValue(makeStoryResult());
    const past = new Date(Date.now() - 60_000).toISOString();
    const db = makeMockDb(wonRow({ id: 'fresh-2' }), { pending: { storyId: 'stale-2', status: 'generating', lockExpiresAt: past } });

    const result = await getOrCreateSharedListeningStory('user-1', db.client, OPENAI_KEY, AZURE_KEY, AZURE_REGION, SECRET);

    expect(db.deleteProgressMock).toHaveBeenCalledTimes(1);
    expect(generateListeningStory).toHaveBeenCalledTimes(1);
    expect(result.sharedStoryId).toBe('fresh-2');
  });

  it('a freshly prepared story exposes its sharedStoryId (needed to consume on practice)', async () => {
    vi.mocked(resolveUserListeningLevel).mockResolvedValue('A1');
    const db = makeMockDb(readyRow({ id: 'story-xyz' }));

    const result = await getOrCreateSharedListeningStory('user-1', db.client, OPENAI_KEY, AZURE_KEY, AZURE_REGION, SECRET);

    expect(result.sharedStoryId).toBe('story-xyz');
  });
});

describe('getPendingListeningStoryForToday — read-only auto-recovery (no generate/select/consume)', () => {
  it('returns the ready pending story (with sharedStoryId), never calling the acquire RPC or generating', async () => {
    // rpcRow would advance to a different story if the acquire RPC were called.
    const db = makeMockDb(wonRow({ id: 'different-story' }), { pending: { storyId: 'pending-1', status: 'ready' } });

    const result = await getPendingListeningStoryForToday('user-1', db.client, SECRET);

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Pending Story');
    expect(result!.sharedStoryId).toBe('pending-1');
    expect(db.rpcMock).not.toHaveBeenCalled();            // no acquire/selection
    expect(generateListeningStory).not.toHaveBeenCalled(); // no AI
    expect(db.upsertProgressMock).not.toHaveBeenCalled();  // no attach (never consumes/creates)
    expect(db.deleteProgressMock).not.toHaveBeenCalled();  // no stale-drop side effects
  });

  it('returns null when there is no pending (client then shows the prompt)', async () => {
    const db = makeMockDb(wonRow(), { pending: null });
    const result = await getPendingListeningStoryForToday('user-1', db.client, SECRET);
    expect(result).toBeNull();
    expect(db.rpcMock).not.toHaveBeenCalled();
  });

  it('returns null for a still-generating pending (not yet resumable, no side effects)', async () => {
    const db = makeMockDb(wonRow(), { pending: { storyId: 'pending-1', status: 'generating' } });
    const result = await getPendingListeningStoryForToday('user-1', db.client, SECRET);
    expect(result).toBeNull();
    expect(db.rpcMock).not.toHaveBeenCalled();
    expect(db.deleteProgressMock).not.toHaveBeenCalled(); // read-only: never drops here
  });

  it('returns null for a failed pending (read-only endpoint never drops/regenerates)', async () => {
    const db = makeMockDb(wonRow(), { pending: { storyId: 'pending-1', status: 'failed' } });
    const result = await getPendingListeningStoryForToday('user-1', db.client, SECRET);
    expect(result).toBeNull();
    expect(db.deleteProgressMock).not.toHaveBeenCalled();
    expect(generateListeningStory).not.toHaveBeenCalled();
  });
});
