import { describe, it, expect, vi } from 'vitest';
import {
  authorizeTrialConversationSession,
  attachTrialConversationSessionGatewayIds,
  releaseTrialConversationSessionAuthorization,
} from '../_entitlements/authorize-trial-conversation-session';

function makeSupabase(rpcResult: { data: unknown; error: unknown }) {
  const chain: any = {};
  for (const m of ['update', 'delete', 'eq']) chain[m] = vi.fn().mockReturnValue(chain);
  return {
    rpc: vi.fn().mockResolvedValue(rpcResult),
    from: vi.fn().mockReturnValue(chain),
  };
}

describe('authorizeTrialConversationSession', () => {
  it('calls the RPC with only userId/requestedMaxSeconds/sessionDate/ids/idempotencyKey — never an assignmentId, window, or total', async () => {
    const supabase = makeSupabase({ data: [{ authorization_id: 'auth-1', authorized_max_seconds: 900, blocked: false, blocked_reason: null }], error: null });
    const result = await authorizeTrialConversationSession(supabase as any, {
      userId: 'u1', requestedMaxSeconds: 45.4, sessionDate: '2026-07-12',
      gatewayBudgetReservationId: null, gatewaySessionId: null, idempotencyKey: 'attempt-1',
    });

    expect(supabase.rpc).toHaveBeenCalledWith('authorize_trial_conversation_session_v1', {
      p_user_id: 'u1',
      p_requested_max_seconds: 45,
      p_session_date: '2026-07-12',
      p_gateway_budget_reservation_id: null,
      p_gateway_session_id: null,
      p_idempotency_key: 'attempt-1',
    });
    expect(result).toEqual({ authorizationId: 'auth-1', authorizedMaxSeconds: 900, blocked: false, blockedReason: null });
  });

  it('floors a fractional requestedMaxSeconds', async () => {
    const supabase = makeSupabase({ data: [{ authorization_id: 'auth-1', authorized_max_seconds: 30, blocked: false, blocked_reason: null }], error: null });
    await authorizeTrialConversationSession(supabase as any, {
      userId: 'u1', requestedMaxSeconds: 30.9, sessionDate: '2026-07-12',
      gatewayBudgetReservationId: null, gatewaySessionId: null, idempotencyKey: 'attempt-2',
    });
    expect(supabase.rpc).toHaveBeenCalledWith('authorize_trial_conversation_session_v1', expect.objectContaining({ p_requested_max_seconds: 30 }));
  });

  it('surfaces blocked=true with the blockedReason when the RPC reports the balance is exhausted', async () => {
    const supabase = makeSupabase({ data: [{ authorization_id: null, authorized_max_seconds: 0, blocked: true, blocked_reason: 'balance_exhausted' }], error: null });
    const result = await authorizeTrialConversationSession(supabase as any, {
      userId: 'u1', requestedMaxSeconds: 30, sessionDate: '2026-07-12',
      gatewayBudgetReservationId: null, gatewaySessionId: null, idempotencyKey: 'attempt-3',
    });
    expect(result).toEqual({ authorizationId: null, authorizedMaxSeconds: 0, blocked: true, blockedReason: 'balance_exhausted' });
  });

  it('surfaces blockedReason=no_active_trial when the resolved plan is not a genuine trial assignment', async () => {
    const supabase = makeSupabase({ data: [{ authorization_id: null, authorized_max_seconds: 0, blocked: true, blocked_reason: 'no_active_trial' }], error: null });
    const result = await authorizeTrialConversationSession(supabase as any, {
      userId: 'u1', requestedMaxSeconds: 30, sessionDate: '2026-07-12',
      gatewayBudgetReservationId: null, gatewaySessionId: null, idempotencyKey: 'attempt-4',
    });
    expect(result.blockedReason).toBe('no_active_trial');
  });

  it('a repeated idempotencyKey resolves to the SAME existing authorization (blocked=false, same id) — the RPC itself decides this', async () => {
    const supabase = makeSupabase({ data: [{ authorization_id: 'auth-1', authorized_max_seconds: 900, blocked: false, blocked_reason: null }], error: null });
    const first = await authorizeTrialConversationSession(supabase as any, {
      userId: 'u1', requestedMaxSeconds: 900, sessionDate: '2026-07-12',
      gatewayBudgetReservationId: null, gatewaySessionId: null, idempotencyKey: 'same-attempt',
    });
    const second = await authorizeTrialConversationSession(supabase as any, {
      userId: 'u1', requestedMaxSeconds: 900, sessionDate: '2026-07-12',
      gatewayBudgetReservationId: null, gatewaySessionId: null, idempotencyKey: 'same-attempt',
    });
    expect(first).toEqual(second);
    expect(supabase.rpc).toHaveBeenNthCalledWith(2, 'authorize_trial_conversation_session_v1', expect.objectContaining({ p_idempotency_key: 'same-attempt' }));
  });

  it('throws on an RPC error — never fails open for a lifetime, non-renewing budget', async () => {
    const supabase = makeSupabase({ data: null, error: { message: 'db down' } });
    await expect(authorizeTrialConversationSession(supabase as any, {
      userId: 'u1', requestedMaxSeconds: 30, sessionDate: '2026-07-12',
      gatewayBudgetReservationId: null, gatewaySessionId: null, idempotencyKey: 'attempt-5',
    })).rejects.toThrow('authorize_trial_conversation_session_v1 failed: db down');
  });

  it('treats a missing row as blocked (no_active_trial) rather than throwing', async () => {
    const supabase = makeSupabase({ data: [], error: null });
    const result = await authorizeTrialConversationSession(supabase as any, {
      userId: 'u1', requestedMaxSeconds: 30, sessionDate: '2026-07-12',
      gatewayBudgetReservationId: null, gatewaySessionId: null, idempotencyKey: 'attempt-6',
    });
    expect(result.blocked).toBe(true);
    expect(result.blockedReason).toBe('no_active_trial');
  });
});

describe('attachTrialConversationSessionGatewayIds', () => {
  it('updates only the guarded authorized row with the caller-supplied ids', async () => {
    const supabase = makeSupabase({ data: null, error: null });
    await attachTrialConversationSessionGatewayIds(supabase as any, 'auth-1', 'budget-1', 'gwsess-1');
    expect(supabase.from).toHaveBeenCalledWith('conversation_session_authorizations');
    const chain = supabase.from.mock.results[0].value;
    expect(chain.update).toHaveBeenCalledWith({ gateway_budget_reservation_id: 'budget-1', gateway_session_id: 'gwsess-1' });
    expect(chain.eq).toHaveBeenCalledWith('id', 'auth-1');
    expect(chain.eq).toHaveBeenCalledWith('status', 'authorized');
  });
});

describe('releaseTrialConversationSessionAuthorization', () => {
  it('deletes only the guarded authorized row', async () => {
    const supabase = makeSupabase({ data: null, error: null });
    await releaseTrialConversationSessionAuthorization(supabase as any, 'auth-1');
    expect(supabase.from).toHaveBeenCalledWith('conversation_session_authorizations');
    const chain = supabase.from.mock.results[0].value;
    expect(chain.delete).toHaveBeenCalled();
    expect(chain.eq).toHaveBeenCalledWith('id', 'auth-1');
    expect(chain.eq).toHaveBeenCalledWith('status', 'authorized');
  });
});
