import { describe, it, expect } from 'vitest';
import { buildSubscriptionViewModel } from './subscription-view-model';
import { SUBSCRIPTION_MESSAGES } from './subscription-copy';
import type { SubscriptionScreenState } from './subscription-types';

const NOW = new Date('2026-07-27T12:00:00Z');

function state(overrides: Partial<SubscriptionScreenState>): SubscriptionScreenState {
  return {
    status: 'trialing',
    trialEndsAt: null,
    trialDaysRemaining: null,
    currentPlanCode: null,
    currentPlanName: null,
    subscriptionProvider: null,
    subscriptionExpiresAt: null,
    ...overrides,
  };
}

describe('buildSubscriptionViewModel — trialing', () => {
  it('shows the active-trial headline, days remaining, and trial limits — no plan cards', () => {
    const vm = buildSubscriptionViewModel(
      state({ status: 'trialing', trialEndsAt: '2026-07-31T12:00:00Z' }),
      NOW,
    );
    expect(vm.headline).toBe(SUBSCRIPTION_MESSAGES.trialingTitle);
    expect(vm.trialDaysRemainingLabel).toBe('4 dias restantes');
    expect(vm.showTrialLimits).toBe(true);
    expect(vm.showPlanCards).toBe(false);
    expect(vm.showManageButton).toBe(false);
  });
});

describe('buildSubscriptionViewModel — active', () => {
  it('shows the current plan, active status, and a formatted renewal date', () => {
    const vm = buildSubscriptionViewModel(
      state({
        status: 'active',
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
    expect(vm.showManageButton).toBe(true);
    expect(vm.showPlanCards).toBe(false);
  });

  it('falls back to an honest "unavailable" label instead of a fabricated date when renewal is unknown', () => {
    const vm = buildSubscriptionViewModel(
      state({ status: 'active', currentPlanName: 'Essencial', subscriptionExpiresAt: null }),
      NOW,
    );
    expect(vm.renewalLabel).toBe(SUBSCRIPTION_MESSAGES.activeRenewalUnavailable);
  });
});

describe('buildSubscriptionViewModel — expired', () => {
  it('shows the trial-ended message and plan cards as the main CTA', () => {
    const vm = buildSubscriptionViewModel(state({ status: 'expired' }), NOW);
    expect(vm.headline).toBe(SUBSCRIPTION_MESSAGES.expiredTitle);
    expect(vm.subheadline).toBe(SUBSCRIPTION_MESSAGES.expiredSubtitle);
    expect(vm.showPlanCards).toBe(true);
    expect(vm.showManageButton).toBe(false);
  });
});

describe('buildSubscriptionViewModel — canceled', () => {
  it('shows the previous plan and a formatted access-end date when still available', () => {
    const vm = buildSubscriptionViewModel(
      state({ status: 'canceled', currentPlanName: 'Plus', subscriptionExpiresAt: '2026-08-05T00:00:00Z' }),
      NOW,
    );
    expect(vm.headline).toBe(SUBSCRIPTION_MESSAGES.canceledTitle);
    expect(vm.canceledPlanName).toBe('Plus');
    expect(vm.accessEndsAtLabel).toMatch(/\d{1,2} de \w+ de 2026/);
    expect(vm.showPlanCards).toBe(true);
  });

  it('falls back to an honest "already ended" label instead of a fabricated date', () => {
    const vm = buildSubscriptionViewModel(
      state({ status: 'canceled', currentPlanName: 'Plus', subscriptionExpiresAt: null }),
      NOW,
    );
    expect(vm.accessEndsAtLabel).toBe(SUBSCRIPTION_MESSAGES.canceledAccessEndedNote);
  });
});

describe('buildSubscriptionViewModel — button visibility matrix', () => {
  it('trialing: no manage button, no plan cards (so no subscribe buttons), restore always offered', () => {
    const vm = buildSubscriptionViewModel(state({ status: 'trialing', trialEndsAt: '2026-07-31T12:00:00Z' }), NOW);
    expect(vm.showManageButton).toBe(false);
    expect(vm.showPlanCards).toBe(false);
    expect(vm.showRestoreButton).toBe(true);
  });

  it('active: manage button shown, no plan cards', () => {
    const vm = buildSubscriptionViewModel(state({ status: 'active', currentPlanName: 'Essencial' }), NOW);
    expect(vm.showManageButton).toBe(true);
    expect(vm.showPlanCards).toBe(false);
    expect(vm.showRestoreButton).toBe(true);
  });

  it('expired: plan cards (both subscribe CTAs) shown, no manage button', () => {
    const vm = buildSubscriptionViewModel(state({ status: 'expired' }), NOW);
    expect(vm.showPlanCards).toBe(true);
    expect(vm.showManageButton).toBe(false);
    expect(vm.showRestoreButton).toBe(true);
  });

  it('canceled: plan cards shown again to let the user re-subscribe, no manage button', () => {
    const vm = buildSubscriptionViewModel(state({ status: 'canceled', currentPlanName: 'Plus' }), NOW);
    expect(vm.showPlanCards).toBe(true);
    expect(vm.showManageButton).toBe(false);
    expect(vm.showRestoreButton).toBe(true);
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
