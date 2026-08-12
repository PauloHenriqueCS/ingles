import { describe, it, expect } from 'vitest';
import { planCardAction, currentCommercialPlanCode } from './subscription-plan-actions';
import type { SubscriptionScreenState } from './subscription-types';

function state(overrides: Partial<SubscriptionScreenState> = {}): SubscriptionScreenState {
  return {
    status: 'trialing',
    accessType: 'trial',
    trialEndsAt: null,
    trialDaysRemaining: null,
    currentPlanCode: null,
    currentPlanName: null,
    subscriptionProvider: null,
    subscriptionExpiresAt: null,
    canManageSubscription: false,
    canRestorePurchases: false,
    ...overrides,
  };
}

describe('currentCommercialPlanCode', () => {
  it('maps a commercial DB plan code (essencial/plus) to the display code', () => {
    expect(currentCommercialPlanCode(state({ accessType: 'commercial', currentPlanCode: 'essencial' }))).toBe('essential');
    expect(currentCommercialPlanCode(state({ accessType: 'commercial', currentPlanCode: 'plus' }))).toBe('plus');
  });
  it('is null for trial, internal, expired/none (no commercial subscription)', () => {
    expect(currentCommercialPlanCode(state({ accessType: 'trial' }))).toBeNull();
    expect(currentCommercialPlanCode(state({ accessType: 'internal', currentPlanCode: '24317180' }))).toBeNull();
    expect(currentCommercialPlanCode(state({ accessType: 'none' }))).toBeNull();
    // commercial but an unexpected code → null (never guess)
    expect(currentCommercialPlanCode(state({ accessType: 'commercial', currentPlanCode: 'free' }))).toBeNull();
  });
});

describe('planCardAction — never hides a plan', () => {
  it('trial → both plans offered as a first subscribe', () => {
    const s = state({ status: 'trialing', accessType: 'trial' });
    expect(planCardAction('essential', s)).toBe('subscribe');
    expect(planCardAction('plus', s)).toBe('subscribe');
  });

  it('no subscription (expired/none) → both subscribe', () => {
    const s = state({ status: 'expired', accessType: 'none' });
    expect(planCardAction('essential', s)).toBe('subscribe');
    expect(planCardAction('plus', s)).toBe('subscribe');
  });

  it('Essencial active → Essencial "current", Plus "upgrade"', () => {
    const s = state({ status: 'active', accessType: 'commercial', currentPlanCode: 'essencial' });
    expect(planCardAction('essential', s)).toBe('current');
    expect(planCardAction('plus', s)).toBe('upgrade');
  });

  it('Plus active → Plus "current", Essencial "downgrade"', () => {
    const s = state({ status: 'active', accessType: 'commercial', currentPlanCode: 'plus' });
    expect(planCardAction('plus', s)).toBe('current');
    expect(planCardAction('essential', s)).toBe('downgrade');
  });

  it('cancelled-but-still-active (accessType commercial) still badges the current plan', () => {
    const s = state({ status: 'canceled', accessType: 'commercial', currentPlanCode: 'plus', subscriptionExpiresAt: '2026-09-01T00:00:00Z' });
    expect(planCardAction('plus', s)).toBe('current');
    expect(planCardAction('essential', s)).toBe('downgrade');
  });

  it('billing_issue on Essencial still badges Essencial and offers Plus as upgrade', () => {
    const s = state({ status: 'billing_issue', accessType: 'commercial', currentPlanCode: 'essencial' });
    expect(planCardAction('essential', s)).toBe('current');
    expect(planCardAction('plus', s)).toBe('upgrade');
  });

  it('internal plan is never commercial → cards resolve to subscribe (but the screen hides them via showPlanCards)', () => {
    const s = state({ status: 'active', accessType: 'internal', currentPlanCode: '24317180' });
    expect(planCardAction('essential', s)).toBe('subscribe');
    expect(planCardAction('plus', s)).toBe('subscribe');
  });
});
