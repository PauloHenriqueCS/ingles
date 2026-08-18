// Focused unit test for safeCompare — the constant-time secret/token
// comparison used by internal cron auth and the listening admin token check.
// Verifies the accept/reject decision matrix (not timing, which is not
// deterministically observable in a unit test).

import { describe, it, expect } from 'vitest';
import { safeCompare } from '../_crypto';

describe('safeCompare', () => {
  it('returns true for identical strings', () => {
    expect(safeCompare('correct-secret', 'correct-secret')).toBe(true);
  });

  it('returns true for identical long/complex tokens', () => {
    const token = 'Bearer ' + 'a1b2c3'.repeat(20);
    expect(safeCompare(token, token)).toBe(true);
  });

  it('returns false for different strings of the same length', () => {
    expect(safeCompare('secret-aaaa', 'secret-bbbb')).toBe(false);
  });

  it('returns false for different strings of different lengths', () => {
    expect(safeCompare('short', 'a-much-longer-secret')).toBe(false);
  });

  it('returns false when the first input is empty', () => {
    expect(safeCompare('', 'nonempty')).toBe(false);
  });

  it('returns false when the second input is empty', () => {
    expect(safeCompare('nonempty', '')).toBe(false);
  });

  it('returns false when both inputs are empty', () => {
    expect(safeCompare('', '')).toBe(false);
  });

  it('returns false when the first input is undefined', () => {
    expect(safeCompare(undefined, 'nonempty')).toBe(false);
  });

  it('returns false when the second input is undefined', () => {
    expect(safeCompare('nonempty', undefined)).toBe(false);
  });

  it('returns false when the first input is null', () => {
    expect(safeCompare(null, 'nonempty')).toBe(false);
  });

  it('returns false when the second input is null', () => {
    expect(safeCompare('nonempty', null)).toBe(false);
  });

  it('returns false when both inputs are undefined', () => {
    expect(safeCompare(undefined, undefined)).toBe(false);
  });

  it('does not treat a prefix as a match', () => {
    expect(safeCompare('Bearer abc', 'Bearer abcdef')).toBe(false);
  });
});
