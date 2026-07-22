/**
 * api/_account/billing-block-repository.ts — public.user_billing_blocks.
 *
 * Covers:
 *  - createAccountDeletionBillingBlock is idempotent (no duplicate insert
 *    when an active block already exists)
 *  - isBillingBlocked / assertBillingAllowed fail CLOSED on a read error —
 *    the opposite direction from the account-deactivation read gate, and
 *    deliberately so: an unreadable billing table must never let a charge
 *    through
 *  - assertBillingAllowed throws BILLING_BLOCKED_ACCOUNT_DEACTIVATED when
 *    an active block exists, and resolves silently when there is none
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom } = vi.hoisted(() => ({ mockFrom: vi.fn() }));

vi.mock('../_ai-gateway/usage-repository', () => ({
  getSharedServiceClient: () => ({ from: mockFrom }),
}));

import {
  createAccountDeletionBillingBlock,
  isBillingBlocked,
  assertBillingAllowed,
  BillingBlockedError,
} from '../_account/billing-block-repository';

function chain(result: { data: any; error: any }) {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    limit: () => builder,
    insert: () => builder,
    maybeSingle: async () => result,
    then: (resolve: any) => resolve(result),
  };
  return builder;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createAccountDeletionBillingBlock', () => {
  it('is idempotent — skips the insert when an active block already exists', async () => {
    mockFrom.mockReturnValueOnce(chain({ data: { id: 'block-1' }, error: null }));
    await createAccountDeletionBillingBlock('user-1');
    expect(mockFrom).toHaveBeenCalledTimes(1); // pre-check only, no insert
  });

  it('inserts a new active block when none exists', async () => {
    mockFrom
      .mockReturnValueOnce(chain({ data: null, error: null })) // pre-check
      .mockReturnValueOnce(chain({ data: null, error: null })); // insert
    await createAccountDeletionBillingBlock('user-1');
    expect(mockFrom).toHaveBeenCalledTimes(2);
  });

  it('tolerates a concurrent unique-violation on insert without throwing', async () => {
    mockFrom
      .mockReturnValueOnce(chain({ data: null, error: null }))
      .mockReturnValueOnce(chain({ data: null, error: { code: '23505' } }));
    await expect(createAccountDeletionBillingBlock('user-1')).resolves.not.toThrow();
  });
});

describe('isBillingBlocked / assertBillingAllowed', () => {
  it('returns false and allows when there is no active block', async () => {
    mockFrom.mockReturnValueOnce(chain({ data: null, error: null }));
    expect(await isBillingBlocked('user-1')).toBe(false);
  });

  it('returns true and throws BILLING_BLOCKED_ACCOUNT_DEACTIVATED when a block exists', async () => {
    mockFrom.mockReturnValueOnce(chain({ data: { id: 'block-1' }, error: null }));
    expect(await isBillingBlocked('user-1')).toBe(true);

    mockFrom.mockReturnValueOnce(chain({ data: { id: 'block-1' }, error: null }));
    let caught: unknown;
    try {
      await assertBillingAllowed('user-1');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BillingBlockedError);
    expect((caught as BillingBlockedError).code).toBe('BILLING_BLOCKED_ACCOUNT_DEACTIVATED');
  });

  it('fails CLOSED (treated as blocked) when the lookup itself errors', async () => {
    mockFrom.mockReturnValueOnce(chain({ data: null, error: { message: 'relation does not exist' } }));
    expect(await isBillingBlocked('user-1')).toBe(true);
  });
});
