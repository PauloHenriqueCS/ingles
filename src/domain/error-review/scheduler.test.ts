import { describe, it, expect } from 'vitest';
import { computeNextSchedule } from './scheduler';

describe('computeNextSchedule — ciclo aprovado 1/7/30/120 → mastered', () => {
  it('novo erro (nível 0) acertou → nível 1, +7 dias', () => {
    expect(computeNextSchedule(0, true)).toEqual({
      newLevel: 1, newStatus: 'scheduled', intervalDays: 7, mastered: false,
    });
  });

  it('nível 1 acertou → nível 2, +30 dias', () => {
    expect(computeNextSchedule(1, true)).toEqual({
      newLevel: 2, newStatus: 'scheduled', intervalDays: 30, mastered: false,
    });
  });

  it('nível 2 acertou → nível 3, +120 dias', () => {
    expect(computeNextSchedule(2, true)).toEqual({
      newLevel: 3, newStatus: 'scheduled', intervalDays: 120, mastered: false,
    });
  });

  it('nível 3 acertou → mastered', () => {
    expect(computeNextSchedule(3, true)).toEqual({
      newLevel: 4, newStatus: 'mastered', intervalDays: null, mastered: true,
    });
  });
});

describe('computeNextSchedule — errar reinicia o ciclo', () => {
  for (const level of [0, 1, 2, 3]) {
    it(`errar no nível ${level} → nível 0, +1 dia`, () => {
      expect(computeNextSchedule(level, false)).toEqual({
        newLevel: 0, newStatus: 'scheduled', intervalDays: 1, mastered: false,
      });
    });
  }
});

describe('computeNextSchedule — independência entre cards', () => {
  it('acertar um card (→7d) e errar outro (→1d) produzem estados distintos', () => {
    const a = computeNextSchedule(0, true);
    const b = computeNextSchedule(0, false);
    expect(a.intervalDays).toBe(7);
    expect(b.intervalDays).toBe(1);
    expect(a).not.toEqual(b);
  });
});
