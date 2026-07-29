import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockHasActiveSubscriptionBillingIssue } = vi.hoisted(() => ({
  mockHasActiveSubscriptionBillingIssue: vi.fn().mockResolvedValue(false),
}));

vi.mock('../_account/billing-block-repository', () => ({
  hasActiveSubscriptionBillingIssue: mockHasActiveSubscriptionBillingIssue,
}));

import { resolveSubscriptionStatus } from '../_entitlements/subscription-status-service';

function makeChain(result: { data: unknown; error?: unknown }) {
  const resolved = Promise.resolve(result);
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => resolved,
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => resolved.then(resolve, reject),
  };
  return chain;
}

interface MockOptions {
  planRow: Record<string, unknown> | null;
  assignmentRow?: { cancelled_at: string | null } | null;
}

function makeMockSupabase({ planRow, assignmentRow = null }: MockOptions) {
  return {
    rpc: vi.fn().mockResolvedValue({ data: planRow ? [planRow] : [], error: null }),
    from: vi.fn(() => makeChain({ data: assignmentRow, error: null })),
  } as any;
}

const NOW = new Date('2026-07-27T12:00:00Z');

beforeEach(() => {
  mockHasActiveSubscriptionBillingIssue.mockReset().mockResolvedValue(false);
});

describe('resolveSubscriptionStatus', () => {
  it('cenário: novo usuário recebe trial — plan_code=trial com atribuição real e window válida → trialing', async () => {
    const supabase = makeMockSupabase({
      planRow: {
        access_allowed: true,
        plan_id: 'plan-trial',
        plan_code: 'trial',
        plan_name: 'Teste gratuito',
        assignment_id: 'assign-1',
        starts_at: '2026-07-25T12:00:00Z',
        ends_at: '2026-08-01T12:00:00Z',
        is_suspended: false,
      },
    });
    const snapshot = await resolveSubscriptionStatus('u1', { supabase, now: NOW });
    expect(snapshot.status).toBe('trialing');
    expect(snapshot.trialEndsAt).toBe('2026-08-01T12:00:00Z');
    expect(snapshot.trialDaysRemaining).toBe(5);
  });

  it('cenário: trial ativo — dias restantes calculados corretamente a partir de ends_at', async () => {
    const supabase = makeMockSupabase({
      planRow: {
        access_allowed: true, plan_id: 'p', plan_code: 'trial', plan_name: 'Teste gratuito',
        assignment_id: 'a1', starts_at: '2026-07-26T12:00:00Z', ends_at: '2026-08-02T12:00:00Z',
        is_suspended: false,
      },
    });
    const snapshot = await resolveSubscriptionStatus('u1', { supabase, now: NOW });
    expect(snapshot.status).toBe('trialing');
    expect(snapshot.trialDaysRemaining).toBe(6);
  });

  it('cenário: trial expirado — sem atribuição real (resolvido via fallback padrão) → expired', async () => {
    const supabase = makeMockSupabase({
      planRow: {
        access_allowed: true, plan_id: 'default-plan', plan_code: 'plano-teste-lojas', plan_name: 'Plano de teste lojas',
        assignment_id: null, starts_at: null, ends_at: null, is_suspended: false,
      },
    });
    const snapshot = await resolveSubscriptionStatus('u1', { supabase, now: NOW });
    expect(snapshot.status).toBe('expired');
  });

  it('cenário: Essencial ativo — atribuição real, plan_code=essencial, sem cancelamento, sem problema de cobrança → active', async () => {
    const supabase = makeMockSupabase({
      planRow: {
        access_allowed: true, plan_id: 'p-essencial', plan_code: 'essencial', plan_name: 'Essencial',
        assignment_id: 'assign-2', starts_at: '2026-07-01T00:00:00Z', ends_at: '2026-08-01T00:00:00Z',
        is_suspended: false,
      },
      assignmentRow: { cancelled_at: null },
    });
    const snapshot = await resolveSubscriptionStatus('u1', { supabase, now: NOW });
    expect(snapshot.status).toBe('active');
    expect(snapshot.planCode).toBe('essencial');
    expect(snapshot.subscriptionExpiresAt).toBe('2026-08-01T00:00:00Z');
  });

  it('cenário: Plus ativo — mesma lógica de Essencial, plan_code diferente → active', async () => {
    const supabase = makeMockSupabase({
      planRow: {
        access_allowed: true, plan_id: 'p-plus', plan_code: 'plus', plan_name: 'Plus',
        assignment_id: 'assign-3', starts_at: '2026-07-01T00:00:00Z', ends_at: '2026-08-01T00:00:00Z',
        is_suspended: false,
      },
      assignmentRow: { cancelled_at: null },
    });
    const snapshot = await resolveSubscriptionStatus('u1', { supabase, now: NOW });
    expect(snapshot.status).toBe('active');
    expect(snapshot.planCode).toBe('plus');
  });

  it('cenário: assinatura cancelada ainda válida até o término — cancelled_at setado, mas atribuição ainda dentro da janela → canceled (nunca expired)', async () => {
    const supabase = makeMockSupabase({
      planRow: {
        access_allowed: true, plan_id: 'p-essencial', plan_code: 'essencial', plan_name: 'Essencial',
        assignment_id: 'assign-4', starts_at: '2026-07-01T00:00:00Z', ends_at: '2026-08-05T00:00:00Z',
        is_suspended: false,
      },
      assignmentRow: { cancelled_at: '2026-07-20T00:00:00Z' },
    });
    const snapshot = await resolveSubscriptionStatus('u1', { supabase, now: NOW });
    expect(snapshot.status).toBe('canceled');
    expect(snapshot.subscriptionExpiresAt).toBe('2026-08-05T00:00:00Z');
  });

  it('cenário: assinatura expirada — cancelamento cujo período já passou não tem mais atribuição real (resolvido via fallback) → expired', async () => {
    const supabase = makeMockSupabase({
      planRow: {
        access_allowed: true, plan_id: 'default-plan', plan_code: 'plano-teste-lojas', plan_name: 'Plano de teste lojas',
        assignment_id: null, starts_at: null, ends_at: null, is_suspended: false,
      },
    });
    const snapshot = await resolveSubscriptionStatus('u1', { supabase, now: NOW });
    expect(snapshot.status).toBe('expired');
  });

  it('cenário: usuário sem plano — admin_resolve_effective_plan_v1 não retorna linha nenhuma → expired, nunca lança exceção', async () => {
    const supabase = makeMockSupabase({ planRow: null });
    const snapshot = await resolveSubscriptionStatus('u1', { supabase, now: NOW });
    expect(snapshot.status).toBe('expired');
    expect(snapshot.planCode).toBeNull();
  });

  it('cenário: billing_issue — flag ativa de cobrança sobrepõe active/canceled', async () => {
    mockHasActiveSubscriptionBillingIssue.mockResolvedValue(true);
    const supabase = makeMockSupabase({
      planRow: {
        access_allowed: true, plan_id: 'p-essencial', plan_code: 'essencial', plan_name: 'Essencial',
        assignment_id: 'assign-5', starts_at: '2026-07-01T00:00:00Z', ends_at: '2026-08-01T00:00:00Z',
        is_suspended: false,
      },
      assignmentRow: { cancelled_at: null },
    });
    const snapshot = await resolveSubscriptionStatus('u1', { supabase, now: NOW });
    expect(snapshot.status).toBe('billing_issue');
  });

  it('billing_issue vence mesmo quando a atribuição também está graciosamente cancelada', async () => {
    mockHasActiveSubscriptionBillingIssue.mockResolvedValue(true);
    const supabase = makeMockSupabase({
      planRow: {
        access_allowed: true, plan_id: 'p-plus', plan_code: 'plus', plan_name: 'Plus',
        assignment_id: 'assign-6', starts_at: '2026-07-01T00:00:00Z', ends_at: '2026-08-01T00:00:00Z',
        is_suspended: false,
      },
      assignmentRow: { cancelled_at: '2026-07-15T00:00:00Z' },
    });
    const snapshot = await resolveSubscriptionStatus('u1', { supabase, now: NOW });
    expect(snapshot.status).toBe('billing_issue');
  });

  it('cenário: frontend não consegue forjar plano — o resolver nunca lê nada do argumento além de userId; a assinatura da função não aceita plano/status', async () => {
    // resolveSubscriptionStatus(userId, deps) — deps só carrega supabase/now
    // (infraestrutura de teste), nunca um plano ou status. A única forma de
    // influenciar o resultado é através do que admin_resolve_effective_plan_v1
    // (SECURITY DEFINER, resolvido só a partir do userId autenticado) retorna.
    expect(resolveSubscriptionStatus.length).toBe(2);
    const supabase = makeMockSupabase({
      planRow: {
        access_allowed: true, plan_id: 'default-plan', plan_code: 'plano-teste-lojas', plan_name: 'Plano de teste lojas',
        assignment_id: null, starts_at: null, ends_at: null, is_suspended: false,
      },
    });
    // Mesmo passando campos extras arbitrários em `deps`, nenhum é lido além
    // de supabase/now — TypeScript já impede isso estruturalmente, este
    // teste documenta a garantia em runtime.
    const snapshot = await resolveSubscriptionStatus('u1', { supabase, now: NOW, ...( { status: 'active', planCode: 'plus' } as any) });
    expect(snapshot.status).toBe('expired');
  });

  it('nunca confia em assignment_origin=default como se fosse uma atribuição real (plan_code=trial sem starts_at nunca vira trialing)', async () => {
    const supabase = makeMockSupabase({
      planRow: {
        access_allowed: true, plan_id: 'p', plan_code: 'trial', plan_name: 'Teste gratuito',
        assignment_id: null, starts_at: null, ends_at: null, is_suspended: false,
      },
    });
    const snapshot = await resolveSubscriptionStatus('u1', { supabase, now: NOW });
    expect(snapshot.status).toBe('expired');
  });
});
