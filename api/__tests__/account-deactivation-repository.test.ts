/**
 * api/_account/deactivation-repository.ts — public.user_account_deactivations.
 *
 * Covers:
 *  - createDeactivation is idempotent when a row already exists (no insert)
 *  - createDeactivation self-heals a unique-violation race by refetching
 *    the winning row instead of erroring
 *  - getActiveDeactivation only ever performs a read (never mutates)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom } = vi.hoisted(() => ({ mockFrom: vi.fn() }));

vi.mock('../_ai-gateway/usage-repository', () => ({
  getSharedServiceClient: () => ({ from: mockFrom }),
}));

import { createDeactivation, getActiveDeactivation } from '../_account/deactivation-repository';

function chain(result: { data: any; error: any }) {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    limit: () => builder,
    insert: () => builder,
    maybeSingle: async () => result,
    single: async () => result,
    then: (resolve: any) => resolve(result),
  };
  return builder;
}

const ROW = {
  id: 'deact-1',
  user_id: 'user-1',
  status: 'deactivated',
  reason: 'user_requested_account_deletion',
  requested_at: '2026-07-23T00:00:00Z',
  deactivated_at: '2026-07-23T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getActiveDeactivation', () => {
  it('returns null when there is no active deactivation', async () => {
    mockFrom.mockReturnValueOnce(chain({ data: null, error: null }));
    const result = await getActiveDeactivation('user-1');
    expect(result).toBeNull();
  });

  it('maps the DB row to camelCase', async () => {
    mockFrom.mockReturnValueOnce(chain({ data: ROW, error: null }));
    const result = await getActiveDeactivation('user-1');
    expect(result).toEqual({
      id: 'deact-1',
      userId: 'user-1',
      status: 'deactivated',
      reason: 'user_requested_account_deletion',
      requestedAt: '2026-07-23T00:00:00Z',
      deactivatedAt: '2026-07-23T00:00:00Z',
    });
  });

  it('throws on a read error rather than silently treating the account as active', async () => {
    mockFrom.mockReturnValueOnce(chain({ data: null, error: { message: 'boom' } }));
    await expect(getActiveDeactivation('user-1')).rejects.toThrow();
  });
});

describe('createDeactivation', () => {
  it('is idempotent — returns the existing row and never inserts a second one', async () => {
    mockFrom.mockReturnValueOnce(chain({ data: ROW, error: null })); // getActiveDeactivation pre-check
    const result = await createDeactivation('user-1');
    expect(result.id).toBe('deact-1');
    expect(mockFrom).toHaveBeenCalledTimes(1); // no insert call at all
  });

  it('inserts a new row when none exists', async () => {
    mockFrom
      .mockReturnValueOnce(chain({ data: null, error: null })) // pre-check: none active
      .mockReturnValueOnce(chain({ data: ROW, error: null })); // insert...select().single()
    const result = await createDeactivation('user-1');
    expect(result.id).toBe('deact-1');
    expect(mockFrom).toHaveBeenCalledTimes(2);
  });

  it('self-heals a concurrent unique-violation by returning the winning row', async () => {
    mockFrom
      .mockReturnValueOnce(chain({ data: null, error: null })) // pre-check: none active yet
      .mockReturnValueOnce(chain({ data: null, error: { code: '23505', message: 'duplicate' } })) // insert loses the race
      .mockReturnValueOnce(chain({ data: ROW, error: null })); // refetch finds the winner
    const result = await createDeactivation('user-1');
    expect(result.id).toBe('deact-1');
  });

  it('throws on a non-conflict insert error instead of reporting fake success', async () => {
    mockFrom
      .mockReturnValueOnce(chain({ data: null, error: null }))
      .mockReturnValueOnce(chain({ data: null, error: { code: '42501', message: 'permission denied' } }));
    await expect(createDeactivation('user-1')).rejects.toThrow();
  });
});
