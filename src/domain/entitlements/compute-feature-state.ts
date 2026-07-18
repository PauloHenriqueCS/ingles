import type { FeatureAccessState, FeatureLimit, LimitPeriod } from './entitlement-types';

export interface ComputeFeatureLimitInput {
  enabled: boolean;
  unlimited: boolean;
  limit: number;
  consumed: number;
  period: LimitPeriod;
  /** Extra balance (e.g. purchased conversation seconds) usable once the period limit is exhausted. */
  extraAvailable?: number;
}

/**
 * The single place that turns raw plan/consumption numbers into the state
 * every screen renders from. Never compute access/remaining/unlimited
 * ad-hoc in a component — call this instead.
 */
export function computeFeatureState(input: ComputeFeatureLimitInput): FeatureLimit {
  const extraAvailable = input.extraAvailable ?? 0;

  if (!input.enabled) {
    return {
      enabled: false,
      unlimited: false,
      limit: input.limit,
      consumed: input.consumed,
      remaining: 0,
      period: input.period,
      state: 'disabled_by_plan',
      canStart: false,
    };
  }

  if (input.unlimited) {
    return {
      enabled: true,
      unlimited: true,
      limit: input.limit,
      consumed: input.consumed,
      remaining: Number.POSITIVE_INFINITY,
      period: input.period,
      state: 'unlimited',
      canStart: true,
    };
  }

  const remaining = Math.max(input.limit - input.consumed, 0);
  if (remaining > 0) {
    return {
      enabled: true,
      unlimited: false,
      limit: input.limit,
      consumed: input.consumed,
      remaining,
      period: input.period,
      state: 'available',
      canStart: true,
    };
  }

  if (extraAvailable > 0) {
    return {
      enabled: true,
      unlimited: false,
      limit: input.limit,
      consumed: input.consumed,
      remaining: extraAvailable,
      period: input.period,
      state: 'available_with_extra_credits',
      canStart: true,
    };
  }

  const exhaustedState: FeatureAccessState = input.period === 'month' ? 'monthly_limit_reached' : 'daily_limit_reached';
  return {
    enabled: true,
    unlimited: false,
    limit: input.limit,
    consumed: input.consumed,
    remaining: 0,
    period: input.period,
    state: exhaustedState,
    canStart: false,
  };
}
