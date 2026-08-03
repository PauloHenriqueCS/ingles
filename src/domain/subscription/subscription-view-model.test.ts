import { describe, it, expect } from 'vitest';
import { buildSubscriptionViewModel } from './subscription-view-model';
import { SUBSCRIPTION_MESSAGES } from './subscription-copy';
import type { SubscriptionScreenState } from './subscription-types';

const NOW = new Date('2026-07-27T12:00:00Z');

function state(overrides: Partial<SubscriptionScreenState>): SubscriptionScreenState {
  return {
    status: 'trialing',
    accessType: 'trial',
    trialEndsAt: null,
    trialDaysRemaining: null,
    currentPlanCode: null,
    currentPlanName: null,
    subscriptionProvider: null,
    subscriptionExpiresAt: null,
    // Matches the real backend today (no store integration) — every test
    // below that wants to exercise the "capability granted" path overrides
    // these explicitly, so the default never silently hides a regression.
    canManageSubscription: false,
    canRestorePurchases: false,
    ...overrides,
  };
}

describe('buildSubscriptionViewModel — trialing', () => {
  it('shows the active-trial headline, days remaining, and trial limits — no plan cards, no store actions', () => {
    const vm = buildSubscriptionViewModel(
      state({ status: 'trialing', accessType: 'trial', trialEndsAt: '2026-07-31T12:00:00Z' }),
      NOW,
    );
    expect(vm.headline).toBe(SUBSCRIPTION_MESSAGES.trialingTitle);
    expect(vm.trialDaysRemainingLabel).toBe('4 dias restantes');
    expect(vm.showTrialLimits).toBe(true);
    expect(vm.showPlanCards).toBe(false);
    expect(vm.showManageButton).toBe(false);
    expect(vm.showRestoreButton).toBe(false);
  });
});

describe('buildSubscriptionViewModel — internal (hand-assigned unlimited plan)', () => {
  it('shows the internal title/status/complementary-note, plan name passed through, never a renewal line', () => {
    const vm = buildSubscriptionViewModel(
      state({ status: 'active', accessType: 'internal', currentPlanName: 'Ilimitado', subscriptionExpiresAt: null }),
      NOW,
    );
    expect(vm.headline).toBe(SUBSCRIPTION_MESSAGES.internalTitle);
    expect(vm.subheadline).toBe(SUBSCRIPTION_MESSAGES.internalComplementaryNote);
    expect(vm.activeStatusLabel).toBe(SUBSCRIPTION_MESSAGES.internalStatusLabel);
    expect(vm.currentPlanName).toBe('Ilimitado');
    expect(vm.renewalLabel).toBeNull();
  });

  it('never shows manage/restore for the internal plan — capabilities are false by construction (no store involved)', () => {
    const vm = buildSubscriptionViewModel(state({ status: 'active', accessType: 'internal' }), NOW);
    expect(vm.showManageButton).toBe(false);
    expect(vm.showRestoreButton).toBe(false);
    expect(vm.showPlanCards).toBe(false);
    expect(vm.showTrialLimits).toBe(false);
  });

  it('even if a genuine renewal-looking date were somehow present, the internal branch never renders it (no renewal concept applies)', () => {
    const vm = buildSubscriptionViewModel(
      state({ status: 'active', accessType: 'internal', subscriptionExpiresAt: '2026-12-31T00:00:00Z' }),
      NOW,
    );
    expect(vm.renewalLabel).toBeNull();
  });

  it('accessType alone decides the internal treatment — a plain commercial "active" state never gets it', () => {
    const vm = buildSubscriptionViewModel(
      state({ status: 'active', accessType: 'commercial', currentPlanName: 'Essencial' }),
      NOW,
    );
    expect(vm.headline).not.toBe(SUBSCRIPTION_MESSAGES.internalTitle);
    expect(vm.activeStatusLabel).toBe(SUBSCRIPTION_MESSAGES.activeStatusLabel);
  });
});

describe('buildSubscriptionViewModel — active (commercial)', () => {
  it('shows the current plan, "Assinatura ativa", and a formatted renewal date', () => {
    const vm = buildSubscriptionViewModel(
      state({
        status: 'active',
        accessType: 'commercial',
        currentPlanCode: 'essential',
        currentPlanName: 'Essencial',
        subscriptionProvider: 'apple',
        subscriptionExpiresAt: '2026-08-15T00:00:00Z',
      }),
      NOW,
    );
    expect(vm.currentPlanName).toBe('Essencial');
    expect(vm.activeStatusLabel).toBe(SUBSCRIPTION_MESSAGES.activeStatusLabel);
    expect(vm.renewalLabel).toMatch(/\d{1,2} de \w+ de 2026/);
    expect(vm.showPlanCards).toBe(false);
  });

  it('Plus: headline/plan name reflect the real plan, not a hardcoded label', () => {
    const vm = buildSubscriptionViewModel(
      state({ status: 'active', accessType: 'commercial', currentPlanCode: 'plus', currentPlanName: 'Plus' }),
      NOW,
    );
    expect(vm.headline).toBe('Plus');
    expect(vm.currentPlanName).toBe('Plus');
  });

  it('omits the renewal line entirely (never a placeholder string) when no real date is known', () => {
    const vm = buildSubscriptionViewModel(
      state({ status: 'active', accessType: 'commercial', currentPlanName: 'Essencial', subscriptionExpiresAt: null }),
      NOW,
    );
    expect(vm.renewalLabel).toBeNull();
  });

  it('no manage/restore capability from the backend yet -> both hidden, even for a real commercial plan', () => {
    const vm = buildSubscriptionViewModel(
      state({ status: 'active', accessType: 'commercial', currentPlanName: 'Essencial' }),
      NOW,
    );
    expect(vm.showManageButton).toBe(false);
    expect(vm.showRestoreButton).toBe(false);
  });

  it('the moment the backend grants a real capability, the screen shows it — never fixed by plan name or status', () => {
    const vm = buildSubscriptionViewModel(
      state({ status: 'active', accessType: 'commercial', currentPlanName: 'Essencial', canManageSubscription: true, canRestorePurchases: true }),
      NOW,
    );
    expect(vm.showManageButton).toBe(true);
    expect(vm.showRestoreButton).toBe(true);
  });
});

describe('buildSubscriptionViewModel — expired', () => {
  it('shows the trial-ended message and plan cards as the main CTA — no renewal, no management', () => {
    const vm = buildSubscriptionViewModel(state({ status: 'expired', accessType: 'none' }), NOW);
    expect(vm.headline).toBe(SUBSCRIPTION_MESSAGES.expiredTitle);
    expect(vm.subheadline).toBe(SUBSCRIPTION_MESSAGES.expiredSubtitle);
    expect(vm.renewalLabel).toBeNull();
    expect(vm.showPlanCards).toBe(true);
    expect(vm.showManageButton).toBe(false);
  });
});

describe('buildSubscriptionViewModel — canceled', () => {
  it('shows the previous plan and a formatted access-end date when still available (period not over yet)', () => {
    const vm = buildSubscriptionViewModel(
      state({ status: 'canceled', accessType: 'commercial', currentPlanName: 'Plus', subscriptionExpiresAt: '2026-08-05T00:00:00Z' }),
      NOW,
    );
    expect(vm.headline).toBe(SUBSCRIPTION_MESSAGES.canceledTitle);
    expect(vm.canceledPlanName).toBe('Plus');
    expect(vm.accessEndsAtLabel).toMatch(/\d{1,2} de \w+ de 2026/);
    expect(vm.showPlanCards).toBe(true);
  });

  it('falls back to an honest "already ended" label instead of a fabricated date', () => {
    const vm = buildSubscriptionViewModel(
      state({ status: 'canceled', accessType: 'commercial', currentPlanName: 'Plus', subscriptionExpiresAt: null }),
      NOW,
    );
    expect(vm.accessEndsAtLabel).toBe(SUBSCRIPTION_MESSAGES.canceledAccessEndedNote);
  });
});

describe('buildSubscriptionViewModel — billing_issue', () => {
  it('shows the payment-problem headline, current plan, and access-until date (accessUntil, never an invented tolerance)', () => {
    const vm = buildSubscriptionViewModel(
      state({
        status: 'billing_issue',
        accessType: 'commercial',
        currentPlanCode: 'essential',
        currentPlanName: 'Essencial',
        subscriptionExpiresAt: '2026-08-01T00:00:00Z',
      }),
      NOW,
    );
    expect(vm.headline).toBe(SUBSCRIPTION_MESSAGES.billingIssueTitle);
    expect(vm.subheadline).toBe(SUBSCRIPTION_MESSAGES.billingIssueSubtitle);
    expect(vm.currentPlanName).toBe('Essencial');
    expect(vm.accessEndsAtLabel).toMatch(/\d{1,2} de \w+ de 2026/);
    expect(vm.showPlanCards).toBe(false);
    expect(vm.showTrialLimits).toBe(false);
  });

  it('never fabricates an access-until date when none is known', () => {
    const vm = buildSubscriptionViewModel(
      state({ status: 'billing_issue', accessType: 'commercial', currentPlanName: 'Plus', subscriptionExpiresAt: null }),
      NOW,
    );
    expect(vm.accessEndsAtLabel).toBeNull();
  });
});

describe('buildSubscriptionViewModel — button visibility matrix (driven by backend capabilities, not status/plan)', () => {
  it('every status hides manage/restore by default — no store integration exists yet', () => {
    const cases: Array<Partial<SubscriptionScreenState>> = [
      { status: 'trialing', accessType: 'trial', trialEndsAt: '2026-07-31T12:00:00Z' },
      { status: 'active', accessType: 'internal' },
      { status: 'active', accessType: 'commercial', currentPlanName: 'Essencial' },
      { status: 'expired', accessType: 'none' },
      { status: 'canceled', accessType: 'commercial', currentPlanName: 'Plus' },
      { status: 'billing_issue', accessType: 'commercial', currentPlanName: 'Essencial' },
    ];
    for (const c of cases) {
      const vm = buildSubscriptionViewModel(state(c), NOW);
      expect(vm.showManageButton).toBe(false);
      expect(vm.showRestoreButton).toBe(false);
    }
  });

  it('trialing: no plan cards (so no subscribe buttons)', () => {
    const vm = buildSubscriptionViewModel(state({ status: 'trialing', accessType: 'trial', trialEndsAt: '2026-07-31T12:00:00Z' }), NOW);
    expect(vm.showPlanCards).toBe(false);
  });

  it('expired: plan cards (both subscribe CTAs) shown', () => {
    const vm = buildSubscriptionViewModel(state({ status: 'expired', accessType: 'none' }), NOW);
    expect(vm.showPlanCards).toBe(true);
  });

  it('canceled: plan cards shown again to let the user re-subscribe', () => {
    const vm = buildSubscriptionViewModel(state({ status: 'canceled', accessType: 'commercial', currentPlanName: 'Plus' }), NOW);
    expect(vm.showPlanCards).toBe(true);
  });
});

describe('buildSubscriptionViewModel — progress preserved after expiration', () => {
  it('the expired-state copy explicitly says data/progress are kept, not erased', () => {
    expect(SUBSCRIPTION_MESSAGES.trialDataPreservedNote).toMatch(/não serão apagados/);
  });

  it('the expired-state copy scopes the block to the four gated activities only', () => {
    expect(SUBSCRIPTION_MESSAGES.trialBlockedActivitiesNote).toMatch(/escrita/);
    expect(SUBSCRIPTION_MESSAGES.trialBlockedActivitiesNote).toMatch(/pronúncia/);
    expect(SUBSCRIPTION_MESSAGES.trialBlockedActivitiesNote).toMatch(/listening/);
    expect(SUBSCRIPTION_MESSAGES.trialBlockedActivitiesNote).toMatch(/conversação/);
    expect(SUBSCRIPTION_MESSAGES.trialBlockedActivitiesNote).toMatch(/perfil, histórico e configurações/);
  });
});
