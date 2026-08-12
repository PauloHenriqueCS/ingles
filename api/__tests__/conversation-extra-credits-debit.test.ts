import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FeatureLimit, PlanEntitlementsSnapshot } from '../../src/domain/entitlements/entitlement-types';

const { mockGetEntitlements } = vi.hoisted(() => ({ mockGetEntitlements: vi.fn() }));
vi.mock('../_entitlements/plan-entitlements-service', () => ({
  getCurrentUserPlanEntitlements: mockGetEntitlements,
}));
vi.mock('../_ai-gateway/usage-repository', () => ({ getSharedServiceClient: () => ({ rpc: vi.fn() }) }));

import { settleConversationExtraCreditsDebit } from '../_entitlements/conversation-extra-credits-debit';

const USER = 'aaaaaaaa-0000-0000-0000-000000000001';
const AUTH = 'bbbbbbbb-0000-0000-0000-000000000002';

function limit(over: Partial<FeatureLimit> = {}): FeatureLimit {
  return { enabled: true, unlimited: false, limit: 1800, consumed: 1800, remaining: 0, period: 'month', state: 'available_with_extra_credits', canStart: true, ...over };
}
function entitlements(monthly: FeatureLimit, extraSecondsAvailable: number): PlanEntitlementsSnapshot {
  return {
    planId: 'p', planCode: 'plus', planName: 'Plus', planVersionId: 'v', suspended: false,
    writing: {} as any, listening: {} as any, pronunciation: {} as any,
    conversation: { enabled: true, monthlyTime: monthly, maxRecordingSeconds: 0, maxRecordingUnlimited: false, extraPurchaseEnabled: true, extraSecondsAvailable },
    monthlyRenewsAt: null, resolvedAt: new Date().toISOString(),
  };
}
function supabaseWithRpc(returnValue: number) {
  const rpc = vi.fn().mockResolvedValue({ data: returnValue, error: null });
  return { supabase: { rpc } as any, rpc };
}

beforeEach(() => vi.clearAllMocks());

describe('settleConversationExtraCreditsDebit', () => {
  it('duration <= 0 → no-op, never calls the RPC', async () => {
    const { supabase, rpc } = supabaseWithRpc(0);
    expect(await settleConversationExtraCreditsDebit(USER, AUTH, 0, { supabase })).toBe(0);
    expect(mockGetEntitlements).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('unlimited (internal) plan → never debits', async () => {
    mockGetEntitlements.mockResolvedValue(entitlements(limit({ unlimited: true, remaining: Number.POSITIVE_INFINITY, state: 'unlimited' }), 600));
    const { supabase, rpc } = supabaseWithRpc(0);
    expect(await settleConversationExtraCreditsDebit(USER, AUTH, 300, { supabase })).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('no purchased balance → never debits', async () => {
    mockGetEntitlements.mockResolvedValue(entitlements(limit(), 0));
    const { supabase, rpc } = supabaseWithRpc(0);
    expect(await settleConversationExtraCreditsDebit(USER, AUTH, 300, { supabase })).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('bounded plan + purchased balance → calls the debit RPC with the plan limit, returns debited seconds', async () => {
    mockGetEntitlements.mockResolvedValue(entitlements(limit({ limit: 1800 }), 600));
    const { supabase, rpc } = supabaseWithRpc(240);
    const debited = await settleConversationExtraCreditsDebit(USER, AUTH, 300, { supabase });
    expect(debited).toBe(240);
    expect(rpc).toHaveBeenCalledWith('debit_conversation_extra_credits_v1', {
      p_user_id: USER, p_authorization_id: AUTH, p_plan_limit_seconds: 1800,
    });
  });

  it('propagates an RPC error (caller wraps best-effort)', async () => {
    mockGetEntitlements.mockResolvedValue(entitlements(limit(), 600));
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } });
    await expect(settleConversationExtraCreditsDebit(USER, AUTH, 300, { supabase: { rpc } as any })).rejects.toThrow(/debit_conversation_extra_credits_v1/);
  });
});
