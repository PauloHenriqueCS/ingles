import { describe, it, expect } from 'vitest';
import type { PlanEntitlementsSnapshot, FeatureLimit } from '../../domain/entitlements/entitlement-types';
import type { PublicConfigValues } from '../../hooks/usePublicConfig';
import { homeUiStrings } from '../../i18n/homeUiStrings';
import {
  writingCardState,
  conversationCardState,
  listeningCardState,
  pronunciationCardState,
  resolveRecommendedActivity,
  secondaryBadge,
  conversationMinutesRemaining,
} from './practiceAvailability';

const s = homeUiStrings('pt-BR');

// ── Fixtures ────────────────────────────────────────────────────────────────

function limit(overrides: Partial<FeatureLimit> = {}): FeatureLimit {
  return {
    enabled: true,
    unlimited: false,
    limit: 10,
    consumed: 0,
    remaining: 10,
    period: 'day',
    state: 'available',
    canStart: true,
    ...overrides,
  };
}

const exhausted = (period: 'day' | 'month' = 'day'): FeatureLimit =>
  limit({
    consumed: 10,
    remaining: 0,
    canStart: false,
    state: period === 'day' ? 'daily_limit_reached' : 'monthly_limit_reached',
  });

function snapshot(overrides: Partial<PlanEntitlementsSnapshot> = {}): PlanEntitlementsSnapshot {
  return {
    planId: 'p1',
    planCode: 'essencial',
    planName: 'Essencial',
    planVersionId: 'v1',
    suspended: false,
    writing: { enabled: true, themeGenerations: limit(), reviews: limit(), maxCharactersPerText: 1000, maxCharactersUnlimited: false },
    listening: { enabled: true, stories: limit({ remaining: 2, limit: 2 }) },
    pronunciation: { enabled: true, evaluations: limit({ remaining: 3, limit: 3 }), maxRecordingSeconds: 60, maxRecordingUnlimited: false },
    conversation: {
      enabled: true,
      monthlyTime: limit({ period: 'month', limit: 3600, consumed: 1080, remaining: 2520 }), // 42 min left
      maxRecordingSeconds: 120,
      maxRecordingUnlimited: false,
      extraPurchaseEnabled: true,
      extraSecondsAvailable: 0,
    },
    monthlyRenewsAt: null,
    resolvedAt: '2026-08-18T00:00:00Z',
    ...overrides,
  };
}

// A minimal public-config where a given feature flag is globally OFF.
function configWithOff(flag: keyof PublicConfigValues): PublicConfigValues {
  return { [flag]: { enabled: false, unavailableMessage: 'off', startsAt: null, endsAt: null } } as unknown as PublicConfigValues;
}

// ── State computation ─────────────────────────────────────────────────────────

describe('activity state', () => {
  it('null entitlements → loading (never a fabricated available)', () => {
    expect(writingCardState(null, null)).toBe('loading');
    expect(conversationCardState(null, null)).toBe('loading');
  });

  it('available when enabled and not exhausted', () => {
    const e = snapshot();
    expect(writingCardState(e, null)).toBe('available');
    expect(conversationCardState(e, null)).toBe('available');
    expect(listeningCardState(e, null)).toBe('available');
    expect(pronunciationCardState(e, null)).toBe('available');
  });

  it('disabled_by_plan when the plan excludes the activity', () => {
    const e = snapshot({ listening: { enabled: false, stories: limit() } });
    expect(listeningCardState(e, null)).toBe('disabled_by_plan');
  });

  it('writing limit_reached only when BOTH generations and reviews are exhausted', () => {
    const bothOut = snapshot({
      writing: { enabled: true, themeGenerations: exhausted(), reviews: exhausted(), maxCharactersPerText: 1000, maxCharactersUnlimited: false },
    });
    expect(writingCardState(bothOut, null)).toBe('limit_reached');

    const onlyReviewsOut = snapshot({
      writing: { enabled: true, themeGenerations: limit(), reviews: exhausted(), maxCharactersPerText: 1000, maxCharactersUnlimited: false },
    });
    expect(writingCardState(onlyReviewsOut, null)).toBe('available');
  });

  it('conversation limit_reached when monthly time is exhausted', () => {
    const e = snapshot({
      conversation: { ...snapshot().conversation, monthlyTime: exhausted('month') },
    });
    expect(conversationCardState(e, null)).toBe('limit_reached');
  });

  it('global config OFF wins over an otherwise-available plan', () => {
    const e = snapshot();
    expect(writingCardState(e, configWithOff('features.writing'))).toBe('disabled_globally');
    expect(listeningCardState(e, configWithOff('features.listening'))).toBe('disabled_globally');
  });
});

// ── Recommendation ─────────────────────────────────────────────────────────────

describe('resolveRecommendedActivity', () => {
  it('recommends writing when it is available', () => {
    expect(resolveRecommendedActivity(snapshot(), null)).toBe('writing');
  });

  it('falls back to the next available activity when writing is blocked', () => {
    const e = snapshot({ writing: { enabled: false, themeGenerations: limit(), reviews: limit(), maxCharactersPerText: 1000, maxCharactersUnlimited: false } });
    expect(resolveRecommendedActivity(e, null)).toBe('conversation');
  });

  it('skips exhausted activities to the first startable one', () => {
    const e = snapshot({
      writing: { enabled: false, themeGenerations: limit(), reviews: limit(), maxCharactersPerText: 1000, maxCharactersUnlimited: false },
      conversation: { ...snapshot().conversation, monthlyTime: exhausted('month') },
    });
    expect(resolveRecommendedActivity(e, null)).toBe('listening');
  });

  it('defaults to writing when nothing is clearly available', () => {
    const e = snapshot({
      writing: { enabled: false, themeGenerations: limit(), reviews: limit(), maxCharactersPerText: 1000, maxCharactersUnlimited: false },
      conversation: { ...snapshot().conversation, monthlyTime: exhausted('month') },
      listening: { enabled: false, stories: limit() },
      pronunciation: { enabled: false, evaluations: limit(), maxRecordingSeconds: 60, maxRecordingUnlimited: false },
    });
    expect(resolveRecommendedActivity(e, null)).toBe('writing');
  });
});

// ── Secondary badges ────────────────────────────────────────────────────────────

describe('secondaryBadge', () => {
  it('loading → no badge', () => {
    expect(secondaryBadge('conversation', 'loading', null, s)).toBeNull();
  });

  it('blocked/exhausted states produce muted/warning badges (never look available)', () => {
    expect(secondaryBadge('listening', 'disabled_by_plan', snapshot(), s)).toEqual({ label: s.notInPlan, tone: 'muted' });
    expect(secondaryBadge('listening', 'disabled_globally', snapshot(), s)).toEqual({ label: s.featureUnavailable, tone: 'muted' });
    expect(secondaryBadge('listening', 'limit_reached', snapshot(), s)).toEqual({ label: s.limitReached, tone: 'warning' });
  });

  it('conversation exhaustion shows "Sem minutos", not "Limite de hoje" (it is a zero balance, not a daily cap)', () => {
    // Conversation has no daily period, so a reset-tomorrow "Limite de hoje" is
    // conceptually wrong — it must read the zero-balance badge (problem 7).
    expect(secondaryBadge('conversation', 'limit_reached', snapshot(), s)).toEqual({ label: s.noMinutes, tone: 'warning' });
    expect(s.noMinutes).not.toBe(s.limitReached);
    // other activities keep the genuine daily-cap wording
    expect(secondaryBadge('listening', 'limit_reached', snapshot(), s).label).toBe(s.limitReached);
  });

  it('conversation available → real minutes remaining', () => {
    expect(secondaryBadge('conversation', 'available', snapshot(), s)).toEqual({ label: s.minutesRemaining(42), tone: 'positive' });
  });

  it('conversation unlimited (no extra) → Ilimitado', () => {
    const e = snapshot({ conversation: { ...snapshot().conversation, monthlyTime: limit({ unlimited: true, period: 'month', state: 'unlimited' }), extraSecondsAvailable: 0 } });
    expect(secondaryBadge('conversation', 'available', e, s)).toEqual({ label: s.unlimited, tone: 'positive' });
  });

  it('listening/pronunciation available → remaining count', () => {
    expect(secondaryBadge('listening', 'available', snapshot(), s)).toEqual({ label: s.remainingCount(2), tone: 'positive' });
    expect(secondaryBadge('pronunciation', 'available', snapshot(), s)).toEqual({ label: s.remainingCount(3), tone: 'positive' });
  });

  it('unlimited listening → Ilimitado', () => {
    const e = snapshot({ listening: { enabled: true, stories: limit({ unlimited: true, state: 'unlimited' }) } });
    expect(secondaryBadge('listening', 'available', e, s)).toEqual({ label: s.unlimited, tone: 'positive' });
  });

  // ── Eligibility boundary: the SAME snapshot drives both the number and the
  //    limit label, so the Home can never show "1 restante" once the gate says 0.
  it('listening remaining=1 → "1 restante"; consuming the last → exhausted state → "Limite de hoje"', () => {
    // remaining = 1 (limit 3, consumed 2): card is available and shows "1 restante".
    const oneLeft = snapshot({ listening: { enabled: true, stories: limit({ limit: 3, consumed: 2, remaining: 1, state: 'available', canStart: true }) } });
    expect(listeningCardState(oneLeft, null)).toBe('available');
    expect(secondaryBadge('listening', listeningCardState(oneLeft, null), oneLeft, s)).toEqual({ label: s.remainingCount(1), tone: 'positive' });

    // remaining = 0 (limit 3, consumed 3): the SAME snapshot flips the card to
    // limit_reached → "Limite de hoje" (never a leftover "1 restante").
    const noneLeft = snapshot({ listening: { enabled: true, stories: limit({ limit: 3, consumed: 3, remaining: 0, state: 'daily_limit_reached', canStart: false }) } });
    expect(noneLeft.listening.stories.canStart).toBe(false); // gate eligibility …
    expect(listeningCardState(noneLeft, null)).toBe('limit_reached'); // … and Home agree
    expect(secondaryBadge('listening', listeningCardState(noneLeft, null), noneLeft, s)).toEqual({ label: s.limitReached, tone: 'warning' });
  });
});

// ── Minute math ─────────────────────────────────────────────────────────────────

describe('conversationMinutesRemaining', () => {
  it('floors plan+extra seconds to whole minutes', () => {
    // 2520 plan + 0 extra = 42 min
    expect(conversationMinutesRemaining(snapshot())).toBe(42);
  });

  it('adds purchased extra seconds on top of plan minutes', () => {
    const e = snapshot({ conversation: { ...snapshot().conversation, extraSecondsAvailable: 600 } }); // +10 min
    expect(conversationMinutesRemaining(e)).toBe(52);
  });

  it('never rounds a positive remainder down to 0 (shows at least 1 min)', () => {
    const e = snapshot({ conversation: { ...snapshot().conversation, monthlyTime: limit({ period: 'month', limit: 3600, consumed: 3570, remaining: 30 }) } });
    expect(conversationMinutesRemaining(e)).toBe(1);
  });

  it('exactly-zero remaining shows 0', () => {
    const e = snapshot({ conversation: { ...snapshot().conversation, monthlyTime: exhausted('month'), extraSecondsAvailable: 0 } });
    expect(conversationMinutesRemaining(e)).toBe(0);
  });

  it('unlimited plan uses purchased extra only', () => {
    const e = snapshot({ conversation: { ...snapshot().conversation, monthlyTime: limit({ unlimited: true, period: 'month' }), extraSecondsAvailable: 120 } });
    expect(conversationMinutesRemaining(e)).toBe(2);
  });
});
