import { describe, it, expect } from 'vitest';
import { formatBillingPeriodPtBr } from './subscription-period';

describe('formatBillingPeriodPtBr', () => {
  it('maps the common monthly/annual store periods', () => {
    expect(formatBillingPeriodPtBr('P1M')).toBe('mês');
    expect(formatBillingPeriodPtBr('P1Y')).toBe('ano');
    expect(formatBillingPeriodPtBr('P1W')).toBe('semana');
    expect(formatBillingPeriodPtBr('P1D')).toBe('dia');
  });

  it('pluralizes multi-unit periods', () => {
    expect(formatBillingPeriodPtBr('P3M')).toBe('3 meses');
    expect(formatBillingPeriodPtBr('P6M')).toBe('6 meses');
    expect(formatBillingPeriodPtBr('P2Y')).toBe('2 anos');
    expect(formatBillingPeriodPtBr('P7D')).toBe('7 dias');
  });

  it('is case/whitespace tolerant', () => {
    expect(formatBillingPeriodPtBr(' p1m ')).toBe('mês');
  });

  it('returns null for empty/unknown input so the caller can fall back', () => {
    expect(formatBillingPeriodPtBr(null)).toBeNull();
    expect(formatBillingPeriodPtBr(undefined)).toBeNull();
    expect(formatBillingPeriodPtBr('')).toBeNull();
    expect(formatBillingPeriodPtBr('monthly')).toBeNull();
    expect(formatBillingPeriodPtBr('P0M')).toBeNull();
    expect(formatBillingPeriodPtBr('PT1H')).toBeNull();
  });
});
