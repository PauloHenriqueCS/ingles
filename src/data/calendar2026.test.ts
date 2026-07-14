import { describe, it, expect } from 'vitest';
import { getAllDatesInMonth, getWeekdaysInMonth, getScheduleForDate } from './calendar2026';

// ── getAllDatesInMonth ─────────────────────────────────────────────────────────

describe('getAllDatesInMonth', () => {
  it('janeiro tem 31 dias', () => {
    expect(getAllDatesInMonth(2026, 1)).toHaveLength(31);
  });

  it('fevereiro 2026 tem 28 dias (não é ano bissexto)', () => {
    expect(getAllDatesInMonth(2026, 2)).toHaveLength(28);
  });

  it('abril tem 30 dias', () => {
    expect(getAllDatesInMonth(2026, 4)).toHaveLength(30);
  });

  it('primeiro dia do mês é 2026-01-01', () => {
    const dates = getAllDatesInMonth(2026, 1);
    expect(dates[0]).toBe('2026-01-01');
  });

  it('último dia de janeiro é 2026-01-31', () => {
    const dates = getAllDatesInMonth(2026, 1);
    expect(dates[dates.length - 1]).toBe('2026-01-31');
  });

  it('formato é YYYY-MM-DD com zeros à esquerda', () => {
    const dates = getAllDatesInMonth(2026, 3);
    expect(dates[0]).toBe('2026-03-01');
    expect(dates[8]).toBe('2026-03-09');
  });

  it('dezembro tem 31 dias', () => {
    expect(getAllDatesInMonth(2026, 12)).toHaveLength(31);
  });
});

// ── getWeekdaysInMonth ────────────────────────────────────────────────────────

describe('getWeekdaysInMonth — padrão (Mon-Fri)', () => {
  it('retorna apenas dias de semana (dom=0, sab=6 excluídos)', () => {
    const days = getWeekdaysInMonth(2026, 1);
    for (const d of days) {
      const dow = new Date(d + 'T12:00:00').getDay();
      expect(dow).toBeGreaterThanOrEqual(1);
      expect(dow).toBeLessThanOrEqual(5);
    }
  });

  it('janeiro 2026 tem 22 dias úteis (Mon-Fri)', () => {
    // Manual count: Jan 2026 starts on Thursday
    // Week 1: Thu1, Fri2 = 2
    // Weeks 2-4: 5 each = 15
    // Week 5: Mon26..Fri30 = 5
    // Total = 22
    expect(getWeekdaysInMonth(2026, 1)).toHaveLength(22);
  });

  it('datas retornadas estão em ordem crescente', () => {
    const days = getWeekdaysInMonth(2026, 1);
    for (let i = 1; i < days.length; i++) {
      expect(days[i] > days[i - 1]).toBe(true);
    }
  });
});

describe('getWeekdaysInMonth — final de semana ativado', () => {
  it('incluir sábado (6) aumenta o total', () => {
    const withoutSat = getWeekdaysInMonth(2026, 1, [1, 2, 3, 4, 5]);
    const withSat    = getWeekdaysInMonth(2026, 1, [1, 2, 3, 4, 5, 6]);
    expect(withSat.length).toBeGreaterThan(withoutSat.length);
  });

  it('com todos os 7 dias ativos, retorna todos os dias do mês', () => {
    const all = getWeekdaysInMonth(2026, 1, [0, 1, 2, 3, 4, 5, 6]);
    expect(all).toHaveLength(31);
  });

  it('somente domingo (0) retorna apenas os domingos de janeiro', () => {
    const sundays = getWeekdaysInMonth(2026, 1, [0]);
    for (const d of sundays) {
      expect(new Date(d + 'T12:00:00').getDay()).toBe(0);
    }
    // January 2026 has 4 Sundays: Jan 4, 11, 18, 25
    expect(sundays).toHaveLength(4);
  });
});

describe('getWeekdaysInMonth — overrideDates', () => {
  it('override inclui uma data que não seria dia útil', () => {
    // 2026-01-03 is a Saturday — not in Mon-Fri
    const days = getWeekdaysInMonth(2026, 1, [1, 2, 3, 4, 5], ['2026-01-03']);
    expect(days).toContain('2026-01-03');
  });

  it('override não duplica datas já incluídas', () => {
    // 2026-01-05 is Monday — already included
    const days = getWeekdaysInMonth(2026, 1, [1, 2, 3, 4, 5], ['2026-01-05']);
    const count = days.filter((d) => d === '2026-01-05').length;
    expect(count).toBe(1);
  });

  it('override vazio não altera o resultado', () => {
    const withoutOverride = getWeekdaysInMonth(2026, 1, [1, 2, 3, 4, 5], []);
    const withEmpty       = getWeekdaysInMonth(2026, 1, [1, 2, 3, 4, 5]);
    expect(withoutOverride).toEqual(withEmpty);
  });

  it('múltiplas datas de override em um fim de semana são todas incluídas', () => {
    const overrides = ['2026-01-03', '2026-01-04']; // Sat and Sun
    const days = getWeekdaysInMonth(2026, 1, [1, 2, 3, 4, 5], overrides);
    expect(days).toContain('2026-01-03');
    expect(days).toContain('2026-01-04');
  });
});

describe('getWeekdaysInMonth — fronteiras', () => {
  it('dezembro 2026 tem dias úteis', () => {
    const days = getWeekdaysInMonth(2026, 12);
    expect(days.length).toBeGreaterThan(20);
  });

  it('activeWeekdays vazio retorna apenas overrideDates', () => {
    const days = getWeekdaysInMonth(2026, 1, [], ['2026-01-10']);
    expect(days).toEqual(['2026-01-10']);
  });
});

// ── Independência de ano ───────────────────────────────────────────────────────

describe('getAllDatesInMonth — anos diferentes de 2026', () => {
  it('fevereiro 2024 tem 29 dias (ano bissexto)', () => {
    expect(getAllDatesInMonth(2024, 2)).toHaveLength(29);
  });

  it('fevereiro 2025 tem 28 dias', () => {
    expect(getAllDatesInMonth(2025, 2)).toHaveLength(28);
  });

  it('dezembro navega corretamente entre anos', () => {
    const dec2025 = getAllDatesInMonth(2025, 12);
    expect(dec2025[0]).toBe('2025-12-01');
    expect(dec2025[dec2025.length - 1]).toBe('2025-12-31');
  });

  it('trabalha com ano 2027', () => {
    const dates = getAllDatesInMonth(2027, 3);
    expect(dates).toHaveLength(31);
    expect(dates[0]).toBe('2027-03-01');
  });
});

describe('getScheduleForDate — independência de ano', () => {
  it('retorna schedule para 2025 (não deve retornar null)', () => {
    const s = getScheduleForDate('2025-09-01', [1, 2, 3, 4, 5]);
    expect(s).not.toBeNull();
  });

  it('retorna schedule para 2027', () => {
    const s = getScheduleForDate('2027-03-15', [1, 2, 3, 4, 5]);
    expect(s).not.toBeNull();
  });

  it('retorna schedule para 2026', () => {
    const s = getScheduleForDate('2026-07-14', [1, 2, 3, 4, 5]);
    expect(s).not.toBeNull();
  });

  it('dia prático tem isPracticeDay true', () => {
    // 2026-07-13 = Monday
    const s = getScheduleForDate('2026-07-13', [1, 2, 3, 4, 5]);
    expect(s?.isPracticeDay).toBe(true);
  });

  it('dia inativo tem isPracticeDay false', () => {
    // 2026-07-11 = Saturday — not in [1,2,3,4,5]
    const s = getScheduleForDate('2026-07-11', [1, 2, 3, 4, 5]);
    expect(s?.isPracticeDay).toBe(false);
  });

  it('dezembro navega para janeiro sem erro', () => {
    const dec = getScheduleForDate('2025-12-31', [1, 2, 3, 4, 5]);
    expect(dec).not.toBeNull();
    const jan = getScheduleForDate('2026-01-01', [1, 2, 3, 4, 5]);
    expect(jan).not.toBeNull();
  });
});
