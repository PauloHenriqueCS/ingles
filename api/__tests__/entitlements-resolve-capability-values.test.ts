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
  it('fails open (true) when nothing configures the key at all', () => {
    expect(resolveEnabledFlag('writing.enabled', [], [])).toBe(true);
  });

  it('respects an explicit plan value of false', () => {
    expect(resolveEnabledFlag('writing.enabled', [{ capability_key: 'writing.enabled', value: false }], [])).toBe(false);
  });

  it('respects an explicit plan value of true', () => {
    expect(resolveEnabledFlag('writing.enabled', [{ capability_key: 'writing.enabled', value: true }], [])).toBe(true);
  });

  it('an active disable override wins over an enabled plan value', () => {
    const planRows = [{ capability_key: 'writing.enabled', value: true }];
    const overrides = [{ capability_key: 'writing.enabled', operation: 'disable' as const, value: null }];
    expect(resolveEnabledFlag('writing.enabled', planRows, overrides)).toBe(false);
  });

  it('an active unlimited override forces true even if the plan disabled it', () => {
    const planRows = [{ capability_key: 'writing.enabled', value: false }];
    const overrides = [{ capability_key: 'writing.enabled', operation: 'unlimited' as const, value: null }];
    expect(resolveEnabledFlag('writing.enabled', planRows, overrides)).toBe(true);
  });
});

describe('resolveNumericLimit', () => {
  const BASE = 'writing.theme_generations_per_day';
  const UNLIMITED = 'writing.theme_generations_per_day.unlimited';

  it('fails open to unlimited when neither key nor any override is configured', () => {
    const result = resolveNumericLimit(BASE, UNLIMITED, [], []);
    expect(result.unlimited).toBe(true);
  });

  it('an explicit finite plan limit with no unlimited row is NOT treated as unconfigured', () => {
    const planRows = [{ capability_key: BASE, value: 3 }];
    const result = resolveNumericLimit(BASE, UNLIMITED, planRows, []);
    expect(result).toEqual({ limit: 3, unlimited: false });
  });

  it('an explicit unlimited=true row wins regardless of the base numeric value', () => {
    const planRows = [{ capability_key: BASE, value: 3 }, { capability_key: UNLIMITED, value: true }];
    const result = resolveNumericLimit(BASE, UNLIMITED, planRows, []);
    expect(result.unlimited).toBe(true);
  });

  it('an explicit unlimited=false row with a configured base limit is respected exactly', () => {
    const planRows = [{ capability_key: BASE, value: 5 }, { capability_key: UNLIMITED, value: false }];
    const result = resolveNumericLimit(BASE, UNLIMITED, planRows, []);
    expect(result).toEqual({ limit: 5, unlimited: false });
  });

  it('override operation=unlimited forces unlimited regardless of plan configuration', () => {
    const planRows = [{ capability_key: BASE, value: 5 }, { capability_key: UNLIMITED, value: false }];
    const overrides = [{ capability_key: BASE, operation: 'unlimited' as const, value: null }];
    const result = resolveNumericLimit(BASE, UNLIMITED, planRows, overrides);
    expect(result.unlimited).toBe(true);
  });

  it('override operation=disable zeroes the limit and clears unlimited', () => {
    const planRows = [{ capability_key: UNLIMITED, value: true }];
    const overrides = [{ capability_key: BASE, operation: 'disable' as const, value: null }];
    const result = resolveNumericLimit(BASE, UNLIMITED, planRows, overrides);
    expect(result).toEqual({ limit: 0, unlimited: false });
  });

  it('override operation=replace sets an exact new limit and clears unlimited', () => {
    const planRows = [{ capability_key: BASE, value: 3 }];
    const overrides = [{ capability_key: BASE, operation: 'replace' as const, value: 10 }];
    const result = resolveNumericLimit(BASE, UNLIMITED, planRows, overrides);
    expect(result).toEqual({ limit: 10, unlimited: false });
  });

  it('override operation=add increments the configured plan limit', () => {
    const planRows = [{ capability_key: BASE, value: 3 }];
    const overrides = [{ capability_key: BASE, operation: 'add' as const, value: 2 }];
    const result = resolveNumericLimit(BASE, UNLIMITED, planRows, overrides);
    expect(result.limit).toBe(5);
    expect(result.unlimited).toBe(false);
  });

  it('override operation=add on an unconfigured base still adds onto zero, not fail-open unlimited', () => {
    const overrides = [{ capability_key: BASE, operation: 'add' as const, value: 2 }];
    const result = resolveNumericLimit(BASE, UNLIMITED, [], overrides);
    expect(result).toEqual({ limit: 2, unlimited: false });
  });
});
