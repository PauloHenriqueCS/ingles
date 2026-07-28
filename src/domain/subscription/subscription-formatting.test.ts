import { describe, it, expect } from 'vitest';
import {
  formatPriceBRL,
  formatPriceBRLPerMonth,
  computeDaysRemaining,
  formatTrialDaysRemainingLabel,
  formatDatePtBr,
} from './subscription-formatting';

describe('formatPriceBRL', () => {
  it('formats the Essencial price as R$ 34,90', () => {
    expect(formatPriceBRL(3490)).toBe('R$ 34,90');
  });

  it('formats the Plus price as R$ 59,90', () => {
    expect(formatPriceBRL(5990)).toBe('R$ 59,90');
  });

  it('formats R$ 34,90/mês', () => {
    expect(formatPriceBRLPerMonth(3490)).toBe('R$ 34,90/mês');
  });
});

describe('computeDaysRemaining', () => {
  const now = new Date('2026-07-27T12:00:00Z');

  it('returns 4 for a date exactly 4 days out', () => {
    expect(computeDaysRemaining('2026-07-31T12:00:00Z', now)).toBe(4);
  });

  it('never returns negative for a past date', () => {
    expect(computeDaysRemaining('2026-07-01T00:00:00Z', now)).toBe(0);
  });

  it('rounds a partial day up so "last day" still reads as 1, not 0', () => {
    expect(computeDaysRemaining('2026-07-27T13:00:00Z', now)).toBe(1);
  });
});

describe('formatTrialDaysRemainingLabel', () => {
  it('shows "Último dia" at 0 days', () => {
    expect(formatTrialDaysRemainingLabel(0)).toBe('Último dia');
  });

  it('uses singular for 1 day', () => {
    expect(formatTrialDaysRemainingLabel(1)).toBe('1 dia restante');
  });

  it('uses plural for more than 1 day', () => {
    expect(formatTrialDaysRemainingLabel(4)).toBe('4 dias restantes');
    expect(formatTrialDaysRemainingLabel(7)).toBe('7 dias restantes');
  });

  it('never goes negative', () => {
    expect(formatTrialDaysRemainingLabel(-3)).toBe('Último dia');
  });
});

describe('formatDatePtBr', () => {
  it('formats a fixed ISO date in long pt-BR form', () => {
    expect(formatDatePtBr('2026-08-03T00:00:00Z')).toMatch(/\d{1,2} de \w+ de 2026/);
  });
});
