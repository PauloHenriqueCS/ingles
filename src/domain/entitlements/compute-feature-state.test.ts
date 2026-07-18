import { describe, it, expect } from 'vitest';
import { computeFeatureState } from './compute-feature-state';

describe('computeFeatureState', () => {
  it('returns disabled_by_plan when the feature is off, regardless of limit/consumed', () => {
    const result = computeFeatureState({ enabled: false, unlimited: false, limit: 5, consumed: 0, period: 'day' });
    expect(result.state).toBe('disabled_by_plan');
    expect(result.canStart).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('returns unlimited when the plan grants unlimited use, even with 0 limit/negative headroom', () => {
    const result = computeFeatureState({ enabled: true, unlimited: true, limit: 0, consumed: 999, period: 'day' });
    expect(result.state).toBe('unlimited');
    expect(result.canStart).toBe(true);
    expect(result.remaining).toBe(Number.POSITIVE_INFINITY);
  });

  it('returns available with correct remaining when under the limit', () => {
    const result = computeFeatureState({ enabled: true, unlimited: false, limit: 5, consumed: 3, period: 'day' });
    expect(result.state).toBe('available');
    expect(result.remaining).toBe(2);
    expect(result.canStart).toBe(true);
  });

  it('returns daily_limit_reached when consumed meets the limit exactly, no extra credits', () => {
    const result = computeFeatureState({ enabled: true, unlimited: false, limit: 5, consumed: 5, period: 'day' });
    expect(result.state).toBe('daily_limit_reached');
    expect(result.canStart).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('returns monthly_limit_reached (not daily) when period is month and limit is exhausted', () => {
    const result = computeFeatureState({ enabled: true, unlimited: false, limit: 600, consumed: 600, period: 'month' });
    expect(result.state).toBe('monthly_limit_reached');
    expect(result.canStart).toBe(false);
  });

  it('never returns a negative remaining when consumed exceeds the limit', () => {
    const result = computeFeatureState({ enabled: true, unlimited: false, limit: 5, consumed: 9, period: 'day' });
    expect(result.remaining).toBe(0);
    expect(result.state).toBe('daily_limit_reached');
  });

  it('returns available_with_extra_credits when the period limit is exhausted but extra balance exists', () => {
    const result = computeFeatureState({
      enabled: true, unlimited: false, limit: 600, consumed: 600, period: 'month', extraAvailable: 200,
    });
    expect(result.state).toBe('available_with_extra_credits');
    expect(result.canStart).toBe(true);
    expect(result.remaining).toBe(200);
  });

  it('ignores extra credits when the base limit still has headroom (does not double-count)', () => {
    const result = computeFeatureState({
      enabled: true, unlimited: false, limit: 600, consumed: 100, period: 'month', extraAvailable: 200,
    });
    expect(result.state).toBe('available');
    expect(result.remaining).toBe(500);
  });

  it('extra credits do not apply when the feature itself is disabled by plan', () => {
    const result = computeFeatureState({
      enabled: false, unlimited: false, limit: 600, consumed: 600, period: 'month', extraAvailable: 200,
    });
    expect(result.state).toBe('disabled_by_plan');
    expect(result.canStart).toBe(false);
  });
});
