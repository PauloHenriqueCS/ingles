import { describe, it, expect } from 'vitest';
import { resolveEnabledFlag, resolveNumericLimit, toNumberOrNull } from '../_entitlements/resolve-capability-values';

describe('toNumberOrNull', () => {
  it('accepts finite numbers', () => expect(toNumberOrNull(5)).toBe(5));
  it('accepts numeric strings', () => expect(toNumberOrNull('12')).toBe(12));
  it('rejects non-numeric strings', () => expect(toNumberOrNull('abc')).toBeNull());
  it('rejects booleans/null/undefined', () => {
    expect(toNumberOrNull(true)).toBeNull();
    expect(toNumberOrNull(null)).toBeNull();
    expect(toNumberOrNull(undefined)).toBeNull();
  });
});

describe('resolveEnabledFlag', () => {
  it('scenario 9: legacy plan with NO entitlements configuration at all fails open (temporarily permissive)', () => {
    const result = resolveEnabledFlag('writing.enabled', [], [], false);
    expect(result).toEqual({ source: 'legacy_fallback', enabled: true });
  });

  it('respects an explicit plan value of false on a configured plan', () => {
    const result = resolveEnabledFlag('writing.enabled', [{ capability_key: 'writing.enabled', value: false }], [], true);
    expect(result).toEqual({ source: 'value', enabled: false });
  });

  it('respects an explicit plan value of true', () => {
    const result = resolveEnabledFlag('writing.enabled', [{ capability_key: 'writing.enabled', value: true }], [], true);
    expect(result).toEqual({ source: 'value', enabled: true });
  });

  it('scenario 11: a configured plan missing THIS key is a config_error, never unlimited/enabled', () => {
    // The plan has some other key configured (hasAnyPlanConfiguration=true) but not this one.
    const result = resolveEnabledFlag('writing.enabled', [{ capability_key: 'listening.enabled', value: true }], [], true);
    expect(result).toEqual({ source: 'config_error' });
  });

  it('an active disable override wins over an enabled plan value', () => {
    const planRows = [{ capability_key: 'writing.enabled', value: true }];
    const overrides = [{ capability_key: 'writing.enabled', operation: 'disable' as const, value: null }];
    const result = resolveEnabledFlag('writing.enabled', planRows, overrides, true);
    expect(result).toEqual({ source: 'value', enabled: false });
  });

  it('scenario 12: an active unlimited override forces enabled=true even on a config_error-prone plan', () => {
    const overrides = [{ capability_key: 'writing.enabled', operation: 'unlimited' as const, value: null }];
    const result = resolveEnabledFlag('writing.enabled', [{ capability_key: 'listening.enabled', value: true }], overrides, true);
    expect(result).toEqual({ source: 'value', enabled: true });
  });
});

describe('resolveNumericLimit', () => {
  const BASE = 'writing.theme_generations_per_day';
  const UNLIMITED = 'writing.theme_generations_per_day.unlimited';

  it('scenario 9: legacy plan (nothing configured at all) fails open to unlimited', () => {
    const result = resolveNumericLimit(BASE, UNLIMITED, [], [], false);
    expect(result).toEqual({ source: 'legacy_fallback', limit: 0, unlimited: true });
  });

  it('scenario 11/12: a plan that has SOME configuration but is missing this key is a config_error, never unlimited', () => {
    const planRows = [{ capability_key: 'listening.stories_per_day', value: 3 }]; // some other key configured
    const result = resolveNumericLimit(BASE, UNLIMITED, planRows, [], true);
    expect(result).toEqual({ source: 'config_error' });
  });

  it('an explicit finite plan limit with no unlimited row is NOT treated as unconfigured', () => {
    const planRows = [{ capability_key: BASE, value: 3 }];
    const result = resolveNumericLimit(BASE, UNLIMITED, planRows, [], true);
    expect(result).toEqual({ source: 'value', limit: 3, unlimited: false });
  });

  it('scenario 13: an explicit unlimited=true row wins regardless of the base numeric value', () => {
    const planRows = [{ capability_key: BASE, value: 3 }, { capability_key: UNLIMITED, value: true }];
    const result = resolveNumericLimit(BASE, UNLIMITED, planRows, [], true);
    expect(result).toEqual({ source: 'value', limit: 3, unlimited: true });
  });

  it('unlimited=true row alone (no base configured) is sufficient — not a config error', () => {
    const planRows = [{ capability_key: UNLIMITED, value: true }];
    const result = resolveNumericLimit(BASE, UNLIMITED, planRows, [], true);
    expect(result).toEqual({ source: 'value', limit: 0, unlimited: true });
  });

  it('an explicit unlimited=false row with a configured base limit is respected exactly', () => {
    const planRows = [{ capability_key: BASE, value: 5 }, { capability_key: UNLIMITED, value: false }];
    const result = resolveNumericLimit(BASE, UNLIMITED, planRows, [], true);
    expect(result).toEqual({ source: 'value', limit: 5, unlimited: false });
  });

  it('unlimited=false row with NO base configured is a config error (finite but no number given)', () => {
    const planRows = [{ capability_key: UNLIMITED, value: false }];
    const result = resolveNumericLimit(BASE, UNLIMITED, planRows, [], true);
    expect(result).toEqual({ source: 'config_error' });
  });

  it('scenario 14: override operation=unlimited forces unlimited regardless of plan configuration', () => {
    const overrides = [{ capability_key: BASE, operation: 'unlimited' as const, value: null }];
    const result = resolveNumericLimit(BASE, UNLIMITED, [], overrides, true);
    expect(result).toEqual({ source: 'value', limit: 0, unlimited: true });
  });

  it('override operation=disable zeroes the limit and clears unlimited, even on a config_error-prone plan', () => {
    const overrides = [{ capability_key: BASE, operation: 'disable' as const, value: null }];
    const result = resolveNumericLimit(BASE, UNLIMITED, [], overrides, true);
    expect(result).toEqual({ source: 'value', limit: 0, unlimited: false });
  });

  it('override operation=replace sets an exact new limit and clears unlimited', () => {
    const planRows = [{ capability_key: BASE, value: 3 }];
    const overrides = [{ capability_key: BASE, operation: 'replace' as const, value: 10 }];
    const result = resolveNumericLimit(BASE, UNLIMITED, planRows, overrides, true);
    expect(result).toEqual({ source: 'value', limit: 10, unlimited: false });
  });

  it('override operation=add increments the configured plan limit', () => {
    const planRows = [{ capability_key: BASE, value: 3 }];
    const overrides = [{ capability_key: BASE, operation: 'add' as const, value: 2 }];
    const result = resolveNumericLimit(BASE, UNLIMITED, planRows, overrides, true);
    expect(result).toEqual({ source: 'value', limit: 5, unlimited: false });
  });

  it('override operation=add on an unconfigured base still adds onto zero, not fail-open unlimited and not a config error', () => {
    const overrides = [{ capability_key: BASE, operation: 'add' as const, value: 2 }];
    const result = resolveNumericLimit(BASE, UNLIMITED, [], overrides, true);
    expect(result).toEqual({ source: 'value', limit: 2, unlimited: false });
  });
});
