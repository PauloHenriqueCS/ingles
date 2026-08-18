import { describe, it, expect } from 'vitest';
import { canOfferNewWriting } from './writing-practice';
import type { WritingEntitlements } from '../entitlements/entitlement-types';

function entitlements(over: Partial<{ enabled: boolean; canStart: boolean; unlimited: boolean; remaining: number }> = {}): WritingEntitlements {
  return {
    enabled: over.enabled ?? true,
    themeGenerations: { enabled: true, unlimited: true, limit: 0, consumed: 0, remaining: Number.POSITIVE_INFINITY, period: 'day', state: 'unlimited', canStart: true },
    reviews: {
      enabled: true,
      unlimited: over.unlimited ?? false,
      limit: 3,
      consumed: 0,
      remaining: over.remaining ?? 2,
      period: 'day',
      state: 'available',
      canStart: over.canStart ?? true,
    },
    maxCharactersPerText: 0,
    maxCharactersUnlimited: true,
  } as WritingEntitlements;
}

describe('canOfferNewWriting — server-authoritative next-practice gate', () => {
  it('offers a new writing when the plan still allows another today (canStart)', () => {
    expect(canOfferNewWriting(entitlements({ canStart: true, remaining: 2 }), false)).toBe(true);
  });

  it('does NOT offer once the daily quota is reached (canStart=false)', () => {
    expect(canOfferNewWriting(entitlements({ canStart: false, remaining: 0 }), false)).toBe(false);
  });

  it('offers for an unlimited plan', () => {
    expect(canOfferNewWriting(entitlements({ unlimited: true, canStart: true }), false)).toBe(true);
  });

  it('never offers when writing is disabled by the plan', () => {
    expect(canOfferNewWriting(entitlements({ canStart: true }), true)).toBe(false);
  });

  it('never offers when entitlements are still loading (null) or the feature is disabled', () => {
    expect(canOfferNewWriting(null, false)).toBe(false);
    expect(canOfferNewWriting(entitlements({ enabled: false, canStart: true }), false)).toBe(false);
  });

  it('the gate reads canStart only — a stale remaining count never overrides it', () => {
    // Even if remaining looks positive, canStart=false (server truth) blocks it.
    expect(canOfferNewWriting(entitlements({ canStart: false, remaining: 5 }), false)).toBe(false);
  });
});
