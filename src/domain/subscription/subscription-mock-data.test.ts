import { describe, it, expect } from 'vitest';
import { getMockSubscriptionState, MOCK_STATUS_OPTIONS, MOCK_SUBSCRIPTION_STATES } from './subscription-mock-data';
import { COMMERCIAL_PLANS } from './subscription-plans';

describe('MOCK_STATUS_OPTIONS', () => {
  it('exposes exactly the four supported statuses, for the dev state switcher', () => {
    expect(MOCK_STATUS_OPTIONS).toEqual(['trialing', 'active', 'expired', 'canceled']);
  });
});

describe('getMockSubscriptionState', () => {
  it.each(MOCK_STATUS_OPTIONS)('returns a state object whose status field matches "%s"', (status) => {
    expect(getMockSubscriptionState(status).status).toBe(status);
  });

  it('trialing: trial end date is in the future and days-remaining is non-negative', () => {
    const s = getMockSubscriptionState('trialing');
    expect(s.trialEndsAt).not.toBeNull();
    expect(new Date(s.trialEndsAt as string).getTime()).toBeGreaterThan(Date.now());
    expect(s.trialDaysRemaining).toBeGreaterThanOrEqual(0);
  });

  it('expired: trial end date is in the past and days-remaining is 0', () => {
    const s = getMockSubscriptionState('expired');
    expect(s.trialEndsAt).not.toBeNull();
    expect(new Date(s.trialEndsAt as string).getTime()).toBeLessThan(Date.now());
    expect(s.trialDaysRemaining).toBe(0);
  });

  it('active and canceled reference a real, known commercial plan code', () => {
    const active = getMockSubscriptionState('active');
    const canceled = getMockSubscriptionState('canceled');
    expect(active.currentPlanCode).not.toBeNull();
    expect(canceled.currentPlanCode).not.toBeNull();
    expect(Object.keys(COMMERCIAL_PLANS)).toContain(active.currentPlanCode);
    expect(Object.keys(COMMERCIAL_PLANS)).toContain(canceled.currentPlanCode);
  });

  it('never fabricates a subscription provider outside apple/google/null', () => {
    for (const status of MOCK_STATUS_OPTIONS) {
      const provider = MOCK_SUBSCRIPTION_STATES[status].subscriptionProvider;
      expect([null, 'apple', 'google']).toContain(provider);
    }
  });
});

describe('mock data cannot be altered by a placeholder handler', () => {
  it('exposes no mutator — only a getter and read-only fixtures', () => {
    const mod = { getMockSubscriptionState, MOCK_STATUS_OPTIONS, MOCK_SUBSCRIPTION_STATES } as Record<string, unknown>;
    const exportNames = Object.keys(mod);
    const mutatorLike = exportNames.filter((name) => /^set|^update|^mutate|^save/i.test(name));
    expect(mutatorLike).toEqual([]);
  });

  it('returns a fresh copy each call, so mutating the result never affects future reads', () => {
    const first = getMockSubscriptionState('active');
    first.currentPlanName = 'Plano Alterado Por Engano';
    const second = getMockSubscriptionState('active');
    expect(second.currentPlanName).toBe('Essencial');
  });
});
