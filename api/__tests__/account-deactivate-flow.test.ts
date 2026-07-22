/**
 * api/_account/deactivate-account.ts — the ordered orchestration flow.
 *
 * Covers:
 *  - Fresh deactivation runs billing block → communication blocks →
 *    deactivation row → session revocation, in that order, each followed by
 *    its audit event
 *  - Session revocation calls Supabase Auth admin with a permanent ban and a
 *    global sign-out keyed off the caller's own access token — never
 *    auth.admin.deleteUser
 *  - Idempotent replay (already deactivated) re-asserts both blocks and
 *    re-revokes sessions, but does not re-create the deactivation row or
 *    re-emit the one-time "deactivated" event
 *  - A failure in Supabase Auth admin is audited as a failure but does not
 *    throw — the internal blocks/flag already committed remain the real
 *    access control
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockGetActiveDeactivation,
  mockCreateDeactivation,
  mockCreateBillingBlock,
  mockCreateCommunicationBlocks,
  mockRecordAccountAuditEvent,
  mockUpdateUserById,
  mockAdminSignOut,
} = vi.hoisted(() => ({
  mockGetActiveDeactivation: vi.fn(),
  mockCreateDeactivation: vi.fn(),
  mockCreateBillingBlock: vi.fn(),
  mockCreateCommunicationBlocks: vi.fn(),
  mockRecordAccountAuditEvent: vi.fn(),
  mockUpdateUserById: vi.fn(),
  mockAdminSignOut: vi.fn(),
}));

vi.mock('../_account/deactivation-repository', () => ({
  getActiveDeactivation: mockGetActiveDeactivation,
  createDeactivation: mockCreateDeactivation,
}));
vi.mock('../_account/billing-block-repository', () => ({
  createAccountDeletionBillingBlock: mockCreateBillingBlock,
}));
vi.mock('../_account/communication-suppression', () => ({
  createAccountDeletionCommunicationBlocks: mockCreateCommunicationBlocks,
}));
vi.mock('../_account/audit', () => ({
  recordAccountAuditEvent: mockRecordAccountAuditEvent,
}));
vi.mock('../_ai-gateway/usage-repository', () => ({
  getSharedServiceClient: () => ({
    auth: { admin: { updateUserById: mockUpdateUserById, signOut: mockAdminSignOut } },
  }),
}));

import { deactivateAccount } from '../_account/deactivate-account';

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateBillingBlock.mockResolvedValue(undefined);
  mockCreateCommunicationBlocks.mockResolvedValue(undefined);
  mockCreateDeactivation.mockResolvedValue({ id: 'd1', userId: 'user-1', status: 'deactivated' });
  mockUpdateUserById.mockResolvedValue({ error: null });
  mockAdminSignOut.mockResolvedValue({ error: null });
});

it('never calls auth.admin.deleteUser (no such mock exists, and nothing references it)', async () => {
  mockGetActiveDeactivation.mockResolvedValue(null);
  await deactivateAccount({ userId: 'user-1', accessToken: 'tok-1', correlationId: 'corr-1' });
  // The only admin.* surface this flow is allowed to touch:
  expect(mockUpdateUserById).toHaveBeenCalled();
  expect(mockAdminSignOut).toHaveBeenCalled();
});

it('runs billing block, then communication blocks, then the deactivation row, in order', async () => {
  mockGetActiveDeactivation.mockResolvedValue(null);
  const order: string[] = [];
  mockCreateBillingBlock.mockImplementation(async () => { order.push('billing'); });
  mockCreateCommunicationBlocks.mockImplementation(async () => { order.push('communication'); });
  mockCreateDeactivation.mockImplementation(async () => { order.push('deactivated'); return { id: 'd1' }; });
  mockAdminSignOut.mockImplementation(async () => { order.push('sessions'); return { error: null }; });

  await deactivateAccount({ userId: 'user-1', accessToken: 'tok-1', correlationId: 'corr-1' });

  expect(order).toEqual(['billing', 'communication', 'deactivated', 'sessions']);
});

it('bans the account permanently and signs out globally using the caller\'s own access token', async () => {
  mockGetActiveDeactivation.mockResolvedValue(null);
  await deactivateAccount({ userId: 'user-1', accessToken: 'the-callers-token', correlationId: 'corr-1' });
  expect(mockUpdateUserById).toHaveBeenCalledWith('user-1', expect.objectContaining({ ban_duration: expect.any(String) }));
  expect(mockAdminSignOut).toHaveBeenCalledWith('the-callers-token', 'global');
});

it('records an audit event for every documented step of a fresh deactivation', async () => {
  mockGetActiveDeactivation.mockResolvedValue(null);
  await deactivateAccount({ userId: 'user-1', accessToken: 'tok-1', correlationId: 'corr-1' });
  const actions = mockRecordAccountAuditEvent.mock.calls.map((c) => c[0].action);
  expect(actions).toEqual(
    expect.arrayContaining([
      'account.self_deactivation_requested',
      'account.billing_block_created',
      'account.communication_blocks_created',
      'account.external_subscription_check',
      'account.entitlements_revoked',
      'account.push_tokens_disabled',
      'account.deactivated',
      'account.ban_applied',
      'account.sessions_revoked',
    ]),
  );
});

it('idempotent replay re-asserts blocks and sessions but does not re-create the deactivation row', async () => {
  mockGetActiveDeactivation.mockResolvedValue({ id: 'd1', userId: 'user-1', status: 'deactivated' });
  const result = await deactivateAccount({ userId: 'user-1', accessToken: 'tok-1', correlationId: 'corr-1' });
  expect(result).toEqual({ status: 'deactivated', alreadyDeactivated: true });
  expect(mockCreateDeactivation).not.toHaveBeenCalled();
  expect(mockCreateBillingBlock).toHaveBeenCalledWith('user-1');
  expect(mockCreateCommunicationBlocks).toHaveBeenCalledWith('user-1');
  expect(mockAdminSignOut).toHaveBeenCalled();
});

it('a Supabase Auth admin failure is audited but does not throw — the internal blocks already stand', async () => {
  mockGetActiveDeactivation.mockResolvedValue(null);
  mockAdminSignOut.mockResolvedValue({ error: { message: 'gotrue unavailable' } });

  await expect(
    deactivateAccount({ userId: 'user-1', accessToken: 'tok-1', correlationId: 'corr-1' }),
  ).resolves.toEqual({ status: 'deactivated', alreadyDeactivated: false });

  expect(mockRecordAccountAuditEvent).toHaveBeenCalledWith(
    expect.objectContaining({ action: 'account.sessions_revoked', result: 'failure' }),
  );
  // The deactivation row and blocks were still committed before the sign-out attempt.
  expect(mockCreateDeactivation).toHaveBeenCalled();
  expect(mockCreateBillingBlock).toHaveBeenCalled();
});
