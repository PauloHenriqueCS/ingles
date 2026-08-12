import { describe, it, expect } from 'vitest';
import { deriveMinuteBalance } from './minute-balance';
import {
  formatMonthlyRemaining,
  formatTotalMinutesAvailable,
  formatConversationBalanceBreakdown,
  formatExtraMinutesAvailable,
} from '../entitlements/entitlement-formatting';

const MIN = 60; // seconds per minute

describe('deriveMinuteBalance — one formula for both screens (seconds)', () => {
  // 1. plano 30, extra 0
  it('[1] plan 30 min, extra 0 → plan-only, total = plan', () => {
    const b = deriveMinuteBalance(30 * MIN, 0, false, 0);
    expect(b).toEqual({ unlimited: false, planRemainingSeconds: 30 * MIN, extraRemainingSeconds: 0, totalRemainingSeconds: 30 * MIN });
  });

  // 2. plano 30, extra 1800 (the reported case)
  it('[2] plan 30 min + extra 1800 min → total 1830 min, both shown', () => {
    const b = deriveMinuteBalance(30 * MIN, 0, false, 1800 * MIN);
    expect(b.planRemainingSeconds).toBe(30 * MIN);
    expect(b.extraRemainingSeconds).toBe(1800 * MIN);
    expect(b.totalRemainingSeconds).toBe(1830 * MIN);
  });

  // 3. plano 0, extra 1800
  it('[3] plan exhausted, extra 1800 min → plan 0, extra only', () => {
    const b = deriveMinuteBalance(30 * MIN, 30 * MIN, false, 1800 * MIN); // consumed == limit
    expect(b.planRemainingSeconds).toBe(0);
    expect(b.extraRemainingSeconds).toBe(1800 * MIN);
    expect(b.totalRemainingSeconds).toBe(1800 * MIN);
  });

  // 4. plano 0, extra 0
  it('[4] nothing left → all zero', () => {
    const b = deriveMinuteBalance(30 * MIN, 30 * MIN, false, 0);
    expect(b.totalRemainingSeconds).toBe(0);
    expect(b.planRemainingSeconds).toBe(0);
    expect(b.extraRemainingSeconds).toBe(0);
  });

  // 5. unlimited
  it('[5] unlimited → unlimited flag, no finite plan counter', () => {
    const b = deriveMinuteBalance(0, 0, true, 900 * MIN);
    expect(b.unlimited).toBe(true);
    expect(b.planRemainingSeconds).toBe(0);
    expect(b.extraRemainingSeconds).toBe(900 * MIN);
    expect(b.totalRemainingSeconds).toBe(900 * MIN);
  });

  it('consumed beyond limit never yields negative plan remaining', () => {
    expect(deriveMinuteBalance(30 * MIN, 45 * MIN, false, 0).planRemainingSeconds).toBe(0);
  });
});

describe('conversation balance copy (exact strings for the reported case)', () => {
  it('plan-only line', () => {
    expect(formatMonthlyRemaining(30 * MIN)).toBe('30 min restantes neste mês');
  });
  it('total + breakdown for plan 30 + extra 1800', () => {
    expect(formatTotalMinutesAvailable(1830 * MIN)).toBe('1830 min disponíveis');
    expect(formatConversationBalanceBreakdown(30 * MIN, 1800 * MIN)).toBe('30 min do plano + 1800 min adicionais');
  });
  it('extra-only line never says "neste mês"', () => {
    const line = formatExtraMinutesAvailable(1800 * MIN);
    expect(line).toBe('1800 min adicionais disponíveis');
    expect(line).not.toContain('neste mês');
  });
});
