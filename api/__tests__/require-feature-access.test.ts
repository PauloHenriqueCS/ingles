import { describe, it, expect } from 'vitest';
import { requireFeatureAccess, checkTextLength, checkRecordingDuration } from '../_entitlements/require-feature-access';
import { computeFeatureState } from '../../src/domain/entitlements/compute-feature-state';

describe('requireFeatureAccess', () => {
  it('denies with FEATURE_DISABLED when the feature is off, regardless of limit state', () => {
    const limit = computeFeatureState({ enabled: false, unlimited: false, limit: 5, consumed: 0, period: 'day' });
    const result = requireFeatureAccess(false, limit, 'exhausted message');
    expect(result).toEqual({ allowed: false, code: 'FEATURE_DISABLED', message: 'Este recurso não está disponível no seu plano atual.' });
  });

  it('denies with DAILY_LIMIT_REACHED for an exhausted day-period limit', () => {
    const limit = computeFeatureState({ enabled: true, unlimited: false, limit: 3, consumed: 3, period: 'day' });
    const result = requireFeatureAccess(true, limit, 'sem gerações hoje');
    expect(result).toEqual({ allowed: false, code: 'DAILY_LIMIT_REACHED', message: 'sem gerações hoje' });
  });

  it('denies with MONTHLY_LIMIT_REACHED for an exhausted month-period limit', () => {
    const limit = computeFeatureState({ enabled: true, unlimited: false, limit: 600, consumed: 600, period: 'month' });
    const result = requireFeatureAccess(true, limit, 'sem minutos');
    expect(result).toEqual({ allowed: false, code: 'MONTHLY_LIMIT_REACHED', message: 'sem minutos' });
  });

  it('allows when unlimited', () => {
    const limit = computeFeatureState({ enabled: true, unlimited: true, limit: 0, consumed: 999, period: 'day' });
    expect(requireFeatureAccess(true, limit, 'x')).toEqual({ allowed: true });
  });

  it('allows with headroom remaining', () => {
    const limit = computeFeatureState({ enabled: true, unlimited: false, limit: 3, consumed: 1, period: 'day' });
    expect(requireFeatureAccess(true, limit, 'x')).toEqual({ allowed: true });
  });
});

describe('checkTextLength', () => {
  it('allows text at or under the limit', () => {
    expect(checkTextLength('a'.repeat(2000), 2000, false).allowed).toBe(true);
  });
  it('denies text over the limit with the exact message', () => {
    const result = checkTextLength('a'.repeat(2001), 2000, false);
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('CHARACTER_LIMIT_EXCEEDED');
    expect(result.message).toContain('2.000');
  });
  it('never blocks when unlimited, no matter the length', () => {
    expect(checkTextLength('a'.repeat(50000), 2000, true).allowed).toBe(true);
  });
});

describe('checkRecordingDuration', () => {
  it('allows a recording at or under the max', () => {
    expect(checkRecordingDuration(30, 30, false).allowed).toBe(true);
  });
  it('denies a recording over the max', () => {
    const result = checkRecordingDuration(31, 30, false);
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('RECORDING_TOO_LONG');
  });
  it('never blocks when unlimited', () => {
    expect(checkRecordingDuration(9999, 30, true).allowed).toBe(true);
  });
});
