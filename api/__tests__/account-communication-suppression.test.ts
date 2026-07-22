/**
 * api/_account/communication-suppression.ts — public.user_communication_blocks.
 *
 * Covers:
 *  - hashDestination: null (never a raw-value fallback) without the secret
 *    configured; deterministic given the secret; normalizes email
 *    case/whitespace so the same address always hashes the same way
 *  - createAccountDeletionCommunicationBlocks only inserts the channels
 *    that don't already have an active block (idempotent per channel)
 *  - canSendCommunication: allowed with no block; blocked by a matching
 *    scope; a scope='all' block also suppresses a 'marketing'/'transactional'
 *    send; an expired block no longer suppresses; fails CLOSED on a lookup
 *    error
 *  - assertCommunicationAllowed throws COMMUNICATION_BLOCKED when blocked
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockFrom } = vi.hoisted(() => ({ mockFrom: vi.fn() }));

vi.mock('../_ai-gateway/usage-repository', () => ({
  getSharedServiceClient: () => ({ from: mockFrom }),
}));

import {
  hashDestination,
  createAccountDeletionCommunicationBlocks,
  canSendCommunication,
  assertCommunicationAllowed,
  CommunicationBlockedError,
} from '../_account/communication-suppression';

function chain(result: { data: any; error: any }) {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    or: () => builder,
    insert: () => builder,
    then: (resolve: any) => resolve(result),
  };
  return builder;
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('hashDestination', () => {
  it('returns null when the HMAC secret is not configured — never falls back to a raw/unsalted hash', () => {
    delete process.env.COMMUNICATION_SUPPRESSION_HMAC_SECRET;
    expect(hashDestination('user@example.com', 'email')).toBeNull();
  });

  it('is deterministic for the same normalized input', () => {
    process.env.COMMUNICATION_SUPPRESSION_HMAC_SECRET = 'test-secret';
    const a = hashDestination('user@example.com', 'email');
    const b = hashDestination('user@example.com', 'email');
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it('normalizes email case and whitespace before hashing', () => {
    process.env.COMMUNICATION_SUPPRESSION_HMAC_SECRET = 'test-secret';
    const a = hashDestination('User@Example.com', 'email');
    const b = hashDestination('  user@example.com  ', 'email');
    expect(a).toBe(b);
  });

  it('produces different hashes for different destinations', () => {
    process.env.COMMUNICATION_SUPPRESSION_HMAC_SECRET = 'test-secret';
    const a = hashDestination('a@example.com', 'email');
    const b = hashDestination('b@example.com', 'email');
    expect(a).not.toBe(b);
  });

  it('never returns the raw destination as the hash', () => {
    process.env.COMMUNICATION_SUPPRESSION_HMAC_SECRET = 'test-secret';
    const hash = hashDestination('user@example.com', 'email');
    expect(hash).not.toContain('user@example.com');
    expect(hash).toMatch(/^[0-9a-f]{64}$/); // hex SHA-256 digest
  });
});

describe('createAccountDeletionCommunicationBlocks', () => {
  it('inserts only the channels missing an active block (idempotent per channel)', async () => {
    mockFrom.mockReturnValueOnce(
      chain({ data: [{ channel: 'email' }, { channel: 'sms' }], error: null }),
    );
    let insertedRows: any[] = [];
    mockFrom.mockImplementationOnce(() => {
      const builder: any = {
        insert: (rows: any[]) => { insertedRows = rows; return { then: (resolve: any) => resolve({ error: null }) }; },
      };
      return builder;
    });
    await createAccountDeletionCommunicationBlocks('user-1');
    const channels = insertedRows.map((r) => r.channel).sort();
    expect(channels).toEqual(['in_app', 'push', 'whatsapp']);
    expect(insertedRows.every((r) => r.scope === 'all' && r.is_active === true)).toBe(true);
  });

  it('does nothing when every channel already has an active block', async () => {
    mockFrom.mockReturnValueOnce(
      chain({
        data: [
          { channel: 'email' }, { channel: 'sms' }, { channel: 'push' },
          { channel: 'whatsapp' }, { channel: 'in_app' },
        ],
        error: null,
      }),
    );
    await createAccountDeletionCommunicationBlocks('user-1');
    expect(mockFrom).toHaveBeenCalledTimes(1); // no insert call
  });
});

describe('canSendCommunication / assertCommunicationAllowed', () => {
  it('allows a send when there is no matching block', async () => {
    mockFrom.mockReturnValueOnce(chain({ data: [], error: null }));
    const allowed = await canSendCommunication({ userId: 'user-1', channel: 'email', scope: 'marketing' });
    expect(allowed).toBe(true);
  });

  it('blocks a marketing send when a scope="all" block exists', async () => {
    mockFrom.mockReturnValueOnce(chain({ data: [{ id: 'b1', expires_at: null }], error: null }));
    const allowed = await canSendCommunication({ userId: 'user-1', channel: 'email', scope: 'marketing' });
    expect(allowed).toBe(false);
  });

  it('an expired block no longer suppresses', async () => {
    mockFrom.mockReturnValueOnce(
      chain({ data: [{ id: 'b1', expires_at: '2020-01-01T00:00:00Z' }], error: null }),
    );
    const allowed = await canSendCommunication({ userId: 'user-1', channel: 'email', scope: 'marketing' });
    expect(allowed).toBe(true);
  });

  it('fails CLOSED (treated as blocked) when the lookup errors', async () => {
    mockFrom.mockReturnValueOnce(chain({ data: null, error: { message: 'relation does not exist' } }));
    const allowed = await canSendCommunication({ userId: 'user-1', channel: 'email', scope: 'marketing' });
    expect(allowed).toBe(false);
  });

  it('returns false with neither userId nor destination, without querying the DB', async () => {
    const allowed = await canSendCommunication({ channel: 'email', scope: 'marketing' });
    expect(allowed).toBe(false);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('assertCommunicationAllowed throws COMMUNICATION_BLOCKED when blocked', async () => {
    mockFrom.mockReturnValueOnce(chain({ data: [{ id: 'b1', expires_at: null }], error: null }));
    let caught: unknown;
    try {
      await assertCommunicationAllowed({ userId: 'user-1', channel: 'sms', scope: 'transactional' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CommunicationBlockedError);
    expect((caught as CommunicationBlockedError).code).toBe('COMMUNICATION_BLOCKED');
  });
});
