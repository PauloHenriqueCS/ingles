import { describe, it, expect, vi } from 'vitest';
import { ListeningPublicationError } from './listening-publication-types';

const { mockGetListeningServiceClient } = vi.hoisted(() => ({
  mockGetListeningServiceClient: vi.fn(),
}));

vi.mock('./_supabase', () => ({
  getListeningServiceClient: mockGetListeningServiceClient,
}));

import { rejectListeningEpisode } from './reject-listening-episode';

function makeClient(episode: { id: string; status: string } | null) {
  const updateCalls: unknown[] = [];
  const insertCalls: unknown[] = [];
  let currentStatus = episode?.status;

  const client = {
    from: (table: string) => {
      if (table === 'listening_episodes') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () =>
                episode ? { data: { id: episode.id, status: currentStatus }, error: null } : { data: null, error: null },
            }),
          }),
          update: (data: unknown) => {
            updateCalls.push(data);
            if (typeof (data as any).status === 'string') currentStatus = (data as any).status;
            return { eq: async () => ({ error: null }) };
          },
        };
      }
      if (table === 'listening_publication_log') {
        return { insert: async (rows: unknown) => { insertCalls.push(rows); return { error: null }; } };
      }
      return { insert: async () => ({ error: null }) };
    },
  };

  return { client, updateCalls, insertCalls };
}

describe('rejectListeningEpisode', () => {
  it('sets status to failed and logs the reason', async () => {
    const { client, updateCalls, insertCalls } = makeClient({ id: 'ep-1', status: 'content_ready' });
    mockGetListeningServiceClient.mockReturnValue(client);

    await rejectListeningEpisode('ep-1', 'exhausted translation-quality correction attempts', 'admin-review');

    expect(updateCalls).toHaveLength(1);
    expect((updateCalls[0] as any).status).toBe('failed');
    expect(insertCalls).toHaveLength(1);
    expect((insertCalls[0] as any).event).toBe('listening_episode_rejected');
    expect((insertCalls[0] as any).details.reason).toBe('exhausted translation-quality correction attempts');
  });

  it('is idempotent when the episode is already failed', async () => {
    const { client, updateCalls } = makeClient({ id: 'ep-1', status: 'failed' });
    mockGetListeningServiceClient.mockReturnValue(client);

    await expect(rejectListeningEpisode('ep-1', 'retry')).resolves.toBeUndefined();
    expect(updateCalls).toHaveLength(0);
  });

  it('refuses to reject a published episode', async () => {
    const { client } = makeClient({ id: 'ep-1', status: 'published' });
    mockGetListeningServiceClient.mockReturnValue(client);

    await expect(rejectListeningEpisode('ep-1', 'x')).rejects.toThrow(ListeningPublicationError);
  });

  it('refuses to reject an archived episode', async () => {
    const { client } = makeClient({ id: 'ep-1', status: 'archived' });
    mockGetListeningServiceClient.mockReturnValue(client);

    await expect(rejectListeningEpisode('ep-1', 'x')).rejects.toThrow(ListeningPublicationError);
  });

  it('throws EPISODE_NOT_FOUND for a missing episode', async () => {
    const { client } = makeClient(null);
    mockGetListeningServiceClient.mockReturnValue(client);

    await expect(rejectListeningEpisode('missing', 'x')).rejects.toThrow(ListeningPublicationError);
  });
});
