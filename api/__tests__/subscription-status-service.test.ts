import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockHasActiveSubscriptionBillingIssue } = vi.hoisted(() => ({
  mockHasActiveSubscriptionBillingIssue: vi.fn().mockResolvedValue(false),
}));

vi.mock('../_account/billing-block-repository', () => ({
  hasActiveSubscriptionBillingIssue: mockHasActiveSubscriptionBillingIssue,
}));

import { resolveSubscriptionStatus, INTERNAL_UNLIMITED_PLAN_CODE } from '../_entitlements/subscription-status-service';

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

interface AssignmentRow {
  cancelled_at: string | null;
  auto_renew?: boolean | null;
  pending_plan_id?: string | null;
  pending_effective_at?: string | null;
}

interface MockOptions {
  planRow: Record<string, unknown> | null;
  assignmentRow?: AssignmentRow | null;
  /** Row returned by the pending-plan lookup (from('plans').eq('id', pendingId)). */
  pendingPlanRow?: { code: string; name: string } | null;
}

function makeMockSupabase({ planRow, assignmentRow = null, pendingPlanRow = null }: MockOptions) {
  return {
    rpc: vi.fn().mockResolvedValue({ data: planRow ? [planRow] : [], error: null }),
    from: vi.fn((table: string) =>
      table === 'plans'
        ? makeChain({ data: pendingPlanRow, error: null })
        : makeChain({ data: assignmentRow, error: null }),
    ),
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

// ── accessType — internal / trial / commercial / none (tailoring the
// /assinatura screen, on top of the unchanged `status` derivation) ─────────
describe('resolveSubscriptionStatus — accessType', () => {
  it('plano interno ilimitado (INTERNAL_UNLIMITED_PLAN_CODE), atribuição real: accessType=internal, acesso ativo, sem data de renovação, sem capacidades de loja', async () => {
    const supabase = makeMockSupabase({
      planRow: {
        access_allowed: true, plan_id: 'plan-internal', plan_code: INTERNAL_UNLIMITED_PLAN_CODE, plan_name: 'Ilimitado',
        assignment_id: 'assign-internal-1', starts_at: '2026-07-01T00:00:00Z', ends_at: null,
        is_suspended: false,
      },
      assignmentRow: { cancelled_at: null },
    });
    const snapshot = await resolveSubscriptionStatus('u1', { supabase, now: NOW });
    expect(snapshot.accessType).toBe('internal');
    expect(snapshot.status).toBe('active');
    expect(snapshot.planName).toBe('Ilimitado');
    expect(snapshot.subscriptionExpiresAt).toBeNull();
    expect(snapshot.canManageSubscription).toBe(false);
    expect(snapshot.canRestorePurchases).toBe(false);
  });

  it('plano interno exige atribuição real — resolvido via fallback (mesmo plan_code) nunca vira internal', async () => {
    // Cannot actually happen through the real RPC (the fallback branch never
    // returns a code equal to a hand-assigned internal plan's own code
    // unless that plan were also is_default=true, which it is not — see
    // ETAPA 1). Still exercised explicitly: assignment_id/starts_at null is
    // what decides 'none', regardless of which plan_code comes back.
    const supabase = makeMockSupabase({
      planRow: {
        access_allowed: true, plan_id: 'plan-internal', plan_code: INTERNAL_UNLIMITED_PLAN_CODE, plan_name: 'Ilimitado',
        assignment_id: null, starts_at: null, ends_at: null, is_suspended: false,
      },
    });
    const snapshot = await resolveSubscriptionStatus('u1', { supabase, now: NOW });
    expect(snapshot.accessType).toBe('none');
    expect(snapshot.status).toBe('expired');
  });

  it('plano default de fallback (plano-teste-lojas): nunca internal, nunca commercial — sempre none', async () => {
    const supabase = makeMockSupabase({
      planRow: {
        access_allowed: true, plan_id: 'default-plan', plan_code: 'plano-teste-lojas', plan_name: 'Plano de teste lojas',
        assignment_id: null, starts_at: null, ends_at: null, is_suspended: false,
      },
    });
    const snapshot = await resolveSubscriptionStatus('u1', { supabase, now: NOW });
    expect(snapshot.accessType).toBe('none');
    expect(snapshot.accessType).not.toBe('internal');
    expect(snapshot.accessType).not.toBe('commercial');
  });

  it('trial ativo: accessType=trial, sem gerenciamento, sem restauração', async () => {
    const supabase = makeMockSupabase({
      planRow: {
        access_allowed: true, plan_id: 'p', plan_code: 'trial', plan_name: 'Teste gratuito',
        assignment_id: 'assign-trial-1', starts_at: '2026-07-25T12:00:00Z', ends_at: '2026-08-01T12:00:00Z',
        is_suspended: false,
      },
    });
    const snapshot = await resolveSubscriptionStatus('u1', { supabase, now: NOW });
    expect(snapshot.accessType).toBe('trial');
    expect(snapshot.canManageSubscription).toBe(false);
    expect(snapshot.canRestorePurchases).toBe(false);
  });

  it('Essencial ativo: accessType=commercial, nome real, sem capacidades de loja antes do RevenueCat', async () => {
    const supabase = makeMockSupabase({
      planRow: {
        access_allowed: true, plan_id: 'p-essencial', plan_code: 'essencial', plan_name: 'Essencial',
        assignment_id: 'assign-2', starts_at: '2026-07-01T00:00:00Z', ends_at: '2026-08-01T00:00:00Z',
        is_suspended: false,
      },
      assignmentRow: { cancelled_at: null },
    });
    const snapshot = await resolveSubscriptionStatus('u1', { supabase, now: NOW });
    expect(snapshot.accessType).toBe('commercial');
    expect(snapshot.planName).toBe('Essencial');
    expect(snapshot.canManageSubscription).toBe(false);
    expect(snapshot.canRestorePurchases).toBe(false);
  });

  it('Plus + pending downgrade cujo pending_effective_at já passou, mas ends_at futuro → pending_downgrade (usa ends_at, NÃO cai em not_renewing)', async () => {
    // The exact sandbox case: PRODUCT_CHANGE recorded pending_plan_id=essencial,
    // but pending_effective_at (a stale tiny-period expiration) is already in the
    // past while Plus is still active until ends_at. Must still be pending_downgrade.
    const supabase = makeMockSupabase({
      planRow: {
        access_allowed: true, plan_id: 'p-plus', plan_code: 'plus', plan_name: 'Plus',
        assignment_id: 'assign-pd', starts_at: '2026-07-20T00:00:00Z', ends_at: '2026-08-10T00:00:00Z', // future
        is_suspended: false,
      },
      assignmentRow: {
        cancelled_at: null,
        auto_renew: false,
        pending_plan_id: 'p-essencial',
        pending_effective_at: '2026-07-21T00:00:00Z', // BEFORE NOW (2026-07-27) — stale/past
      },
      pendingPlanRow: { code: 'essencial', name: 'Essencial' },
    });
    const snapshot = await resolveSubscriptionStatus('u1', { supabase, now: NOW });
    expect(snapshot.subscriptionState).toBe('pending_downgrade');
    expect(snapshot.pendingPlanCode).toBe('essencial');
    expect(snapshot.pendingPlanName).toBe('Essencial');
    // effective date is the LIVE period end (ends_at), not the stale stored value
    expect(snapshot.effectiveChangeAt).toBe('2026-08-10T00:00:00Z');
    expect(snapshot.status).toBe('active'); // never 'canceled'
    expect(snapshot.subscriptionState).not.toBe('not_renewing');
  });

  it('Plus + auto_renew false SEM pending_plan_id → not_renewing (fallback honesto, nunca cancelada)', async () => {
    const supabase = makeMockSupabase({
      planRow: {
        access_allowed: true, plan_id: 'p-plus', plan_code: 'plus', plan_name: 'Plus',
        assignment_id: 'assign-nr', starts_at: '2026-07-01T00:00:00Z', ends_at: '2026-08-10T00:00:00Z',
        is_suspended: false,
      },
      assignmentRow: { cancelled_at: null, auto_renew: false, pending_plan_id: null, pending_effective_at: null },
    });
    const snapshot = await resolveSubscriptionStatus('u1', { supabase, now: NOW });
    expect(snapshot.subscriptionState).toBe('not_renewing');
    expect(snapshot.status).toBe('active');
  });

  it('Plus ativo: accessType=commercial, nome real, sem capacidades de loja antes do RevenueCat', async () => {
    const supabase = makeMockSupabase({
      planRow: {
        access_allowed: true, plan_id: 'p-plus', plan_code: 'plus', plan_name: 'Plus',
        assignment_id: 'assign-3', starts_at: '2026-07-01T00:00:00Z', ends_at: '2026-08-01T00:00:00Z',
        is_suspended: false,
      },
      assignmentRow: { cancelled_at: null },
    });
    const snapshot = await resolveSubscriptionStatus('u1', { supabase, now: NOW });
    expect(snapshot.accessType).toBe('commercial');
    expect(snapshot.planName).toBe('Plus');
    expect(snapshot.canManageSubscription).toBe(false);
    expect(snapshot.canRestorePurchases).toBe(false);
  });

  it('expired: accessType=none, sem renovação, sem gerenciamento', async () => {
    const supabase = makeMockSupabase({
      planRow: {
        access_allowed: true, plan_id: 'default-plan', plan_code: 'plano-teste-lojas', plan_name: 'Plano de teste lojas',
        assignment_id: null, starts_at: null, ends_at: null, is_suspended: false,
      },
    });
    const snapshot = await resolveSubscriptionStatus('u1', { supabase, now: NOW });
    expect(snapshot.accessType).toBe('none');
    expect(snapshot.subscriptionExpiresAt).toBeNull();
    expect(snapshot.canManageSubscription).toBe(false);
  });

  it('cancelado dentro do período: accessType=commercial, acesso mantido até a data real', async () => {
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
    expect(snapshot.accessType).toBe('commercial');
    expect(snapshot.subscriptionExpiresAt).toBe('2026-08-05T00:00:00Z');
  });

  it('cancelado após o período: sem atribuição real (fallback) — accessType=none, acesso encerrado', async () => {
    const supabase = makeMockSupabase({
      planRow: {
        access_allowed: true, plan_id: 'default-plan', plan_code: 'plano-teste-lojas', plan_name: 'Plano de teste lojas',
        assignment_id: null, starts_at: null, ends_at: null, is_suspended: false,
      },
    });
    const snapshot = await resolveSubscriptionStatus('u1', { supabase, now: NOW });
    expect(snapshot.status).toBe('expired');
    expect(snapshot.accessType).toBe('none');
  });

  it('billing_issue dentro do período: accessType=commercial, respeita accessUntil (subscriptionExpiresAt = ends_at real, nunca uma tolerância inventada)', async () => {
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
    expect(snapshot.accessType).toBe('commercial');
    expect(snapshot.subscriptionExpiresAt).toBe('2026-08-01T00:00:00Z');
  });

  it('billing_issue após o período: sem atribuição real (fallback) — accessType=none, bloqueado', async () => {
    mockHasActiveSubscriptionBillingIssue.mockResolvedValue(true);
    const supabase = makeMockSupabase({
      planRow: {
        access_allowed: true, plan_id: 'default-plan', plan_code: 'plano-teste-lojas', plan_name: 'Plano de teste lojas',
        assignment_id: null, starts_at: null, ends_at: null, is_suspended: false,
      },
    });
    const snapshot = await resolveSubscriptionStatus('u1', { supabase, now: NOW });
    expect(snapshot.status).toBe('expired');
    expect(snapshot.accessType).toBe('none');
  });
});
