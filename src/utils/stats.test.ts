import { describe, it, expect } from 'vitest';
import { computeStats } from './stats';
import type { DayEntry, EntriesStore } from '../types';

// ── Helpers ───────────────────────────────────────────────────────────────────

// Use a fixed date in 2026 so getWeekdaysInMonth(2026, m) covers the right dates
const TODAY_2026 = new Date('2026-01-15T12:00:00Z'); // Thursday in Jan 2026

function makeEntry(date: string, overrides: Partial<DayEntry> = {}): DayEntry {
  return {
    date,
    title: 'Test entry',
    originalText: 'Hello world, this is my test.',
    correctedText: '',
    observations: '',
    mainErrors: '',
    difficulty: null,
    status: 'escrito',
    wordCount: 6,
    updatedAt: date + 'T12:00:00Z',
    aiReview: null,
    reviewedAt: null,
    ...overrides,
  };
}

function makeReview(score: number, level: string = 'B1') {
  return {
    score,
    level: level as 'A1',
    grammar: score,
    vocabulary: score,
    naturalness: score,
    fluency: score,
    summary: 'Good',
    correctedText: 'Corrected',
    mainMistakes: [],
    newVocabulary: [],
    objectiveFeedback: 'OK',
    nextPractice: 'Keep going',
  };
}

// ── Empty store ───────────────────────────────────────────────────────────────

describe('computeStats — store vazio', () => {
  it('retorna zeros para todas as contagens', () => {
    const s = computeStats({}, TODAY_2026);
    expect(s.textsThisMonth).toBe(0);
    expect(s.textsThisYear).toBe(0);
    expect(s.currentStreak).toBe(0);
    expect(s.bestStreak).toBe(0);
    expect(s.totalWords).toBe(0);
    expect(s.avgWords).toBe(0);
  });

  it('aiStats tem reviewedCount zero e avgScore zero', () => {
    const s = computeStats({}, TODAY_2026);
    expect(s.aiStats.reviewedCount).toBe(0);
    expect(s.aiStats.avgScore).toBe(0);
    expect(s.aiStats.latestLevel).toBeNull();
  });

  it('monthlyStats tem 12 entradas', () => {
    const s = computeStats({}, TODAY_2026);
    expect(s.monthlyStats).toHaveLength(12);
  });
});

// ── Contagem de textos ─────────────────────────────────────────────────────

describe('computeStats — contagem de textos', () => {
  it('conta textos escritos no mês atual', () => {
    const entries: EntriesStore = {
      '2026-01-05': makeEntry('2026-01-05'),
      '2026-01-12': makeEntry('2026-01-12'),
    };
    const s = computeStats(entries, TODAY_2026);
    expect(s.textsThisMonth).toBe(2);
  });

  it('não conta entradas de outros meses em textsThisMonth', () => {
    const entries: EntriesStore = {
      '2026-01-05': makeEntry('2026-01-05'),
      '2026-02-03': makeEntry('2026-02-03'),
    };
    const s = computeStats(entries, TODAY_2026);
    expect(s.textsThisMonth).toBe(1);
  });

  it('conta textos em textsThisYear para o ano corrente', () => {
    const entries: EntriesStore = {
      '2026-01-05': makeEntry('2026-01-05'),
      '2026-06-10': makeEntry('2026-06-10'),
    };
    // Use a date in June to capture both
    const s = computeStats(entries, new Date('2026-06-15T12:00:00Z'));
    expect(s.textsThisYear).toBe(2);
  });

  it('não conta entradas com status nao-iniciado', () => {
    const entries: EntriesStore = {
      '2026-01-05': makeEntry('2026-01-05', { status: 'nao-iniciado' }),
    };
    const s = computeStats(entries, TODAY_2026);
    expect(s.textsThisMonth).toBe(0);
  });

  it('não conta entradas com originalText vazio', () => {
    const entries: EntriesStore = {
      '2026-01-05': makeEntry('2026-01-05', { originalText: '   ', status: 'escrito' }),
    };
    const s = computeStats(entries, TODAY_2026);
    expect(s.textsThisMonth).toBe(0);
  });
});

// ── Total de palavras ─────────────────────────────────────────────────────────

describe('computeStats — palavras', () => {
  it('soma wordCount de todas as entradas escritas', () => {
    const entries: EntriesStore = {
      '2026-01-05': makeEntry('2026-01-05', { wordCount: 50 }),
      '2026-01-12': makeEntry('2026-01-12', { wordCount: 100 }),
    };
    const s = computeStats(entries, TODAY_2026);
    expect(s.totalWords).toBe(150);
  });

  it('calcula média de palavras por texto', () => {
    const entries: EntriesStore = {
      '2026-01-05': makeEntry('2026-01-05', { wordCount: 50 }),
      '2026-01-12': makeEntry('2026-01-12', { wordCount: 100 }),
    };
    const s = computeStats(entries, TODAY_2026);
    expect(s.avgWords).toBe(75);
  });

  it('avgWords é 0 quando não há textos escritos', () => {
    expect(computeStats({}, TODAY_2026).avgWords).toBe(0);
  });
});

// ── Streak ────────────────────────────────────────────────────────────────────

describe('computeStats — streak', () => {
  it('2 dias consecutivos de semana → streak 2', () => {
    // 2026-01-05 (Mon) and 2026-01-06 (Tue) are consecutive weekdays
    const entries: EntriesStore = {
      '2026-01-05': makeEntry('2026-01-05'),
      '2026-01-06': makeEntry('2026-01-06'),
    };
    // today is 2026-01-06 to count both
    const s = computeStats(entries, new Date('2026-01-06T12:00:00Z'));
    expect(s.currentStreak).toBe(2);
  });

  it('dia perdido quebra o streak atual', () => {
    // 2026-01-05 (Mon) written, 2026-01-06 (Tue) NOT written, today is 2026-01-07 (Wed) written
    const entries: EntriesStore = {
      '2026-01-05': makeEntry('2026-01-05'),
      '2026-01-07': makeEntry('2026-01-07'),
    };
    const s = computeStats(entries, new Date('2026-01-07T12:00:00Z'));
    expect(s.currentStreak).toBe(1);
  });

  it('bestStreak rastreia a maior sequência histórica', () => {
    // 3 days in a row: Mon Jan 5, Tue Jan 6, Wed Jan 7
    const entries: EntriesStore = {
      '2026-01-05': makeEntry('2026-01-05'),
      '2026-01-06': makeEntry('2026-01-06'),
      '2026-01-07': makeEntry('2026-01-07'),
    };
    const s = computeStats(entries, new Date('2026-01-15T12:00:00Z'));
    expect(s.bestStreak).toBeGreaterThanOrEqual(3);
  });

  it('store vazio → streak 0', () => {
    const s = computeStats({}, TODAY_2026);
    expect(s.currentStreak).toBe(0);
    expect(s.bestStreak).toBe(0);
  });
});

// ── AI stats ──────────────────────────────────────────────────────────────────

describe('computeStats — aiStats', () => {
  it('reviewedCount conta apenas entradas com aiReview', () => {
    const entries: EntriesStore = {
      '2026-01-05': makeEntry('2026-01-05', { aiReview: makeReview(80), reviewedAt: '2026-01-05T13:00:00Z' }),
      '2026-01-06': makeEntry('2026-01-06'), // no review
    };
    const s = computeStats(entries, TODAY_2026);
    expect(s.aiStats.reviewedCount).toBe(1);
  });

  it('avgScore é a média das notas', () => {
    const entries: EntriesStore = {
      '2026-01-05': makeEntry('2026-01-05', { aiReview: makeReview(80), reviewedAt: '2026-01-05T13:00:00Z' }),
      '2026-01-06': makeEntry('2026-01-06', { aiReview: makeReview(60), reviewedAt: '2026-01-06T13:00:00Z' }),
    };
    const s = computeStats(entries, TODAY_2026);
    expect(s.aiStats.avgScore).toBe(70);
  });

  it('latestLevel vem da revisão mais recente', () => {
    const entries: EntriesStore = {
      '2026-01-05': makeEntry('2026-01-05', {
        aiReview: makeReview(70, 'A2'),
        reviewedAt: '2026-01-05T10:00:00Z',
      }),
      '2026-01-06': makeEntry('2026-01-06', {
        aiReview: makeReview(80, 'B1'),
        reviewedAt: '2026-01-06T10:00:00Z',
      }),
    };
    const s = computeStats(entries, TODAY_2026);
    expect(s.aiStats.latestLevel).toBe('B1');
  });

  it('latestLevel é null quando nenhuma revisão existe', () => {
    const s = computeStats({}, TODAY_2026);
    expect(s.aiStats.latestLevel).toBeNull();
  });

  it('avgGrammar, avgVocabulary, avgNaturalness, avgFluency são calculados separadamente', () => {
    const entries: EntriesStore = {
      '2026-01-05': makeEntry('2026-01-05', {
        aiReview: { ...makeReview(80), grammar: 90, vocabulary: 70, naturalness: 85, fluency: 75 },
        reviewedAt: '2026-01-05T13:00:00Z',
      }),
    };
    const s = computeStats(entries, TODAY_2026);
    expect(s.aiStats.avgGrammar).toBe(90);
    expect(s.aiStats.avgVocabulary).toBe(70);
    expect(s.aiStats.avgNaturalness).toBe(85);
    expect(s.aiStats.avgFluency).toBe(75);
  });

  it('monthlyAvgScores tem 12 entradas (uma por mês)', () => {
    const s = computeStats({}, TODAY_2026);
    expect(s.aiStats.monthlyAvgScores).toHaveLength(12);
  });

  it('monthlyAvgScores.count reflete revisões daquele mês', () => {
    const entries: EntriesStore = {
      '2026-01-05': makeEntry('2026-01-05', { aiReview: makeReview(80), reviewedAt: '2026-01-05T13:00:00Z' }),
      '2026-02-03': makeEntry('2026-02-03', { aiReview: makeReview(70), reviewedAt: '2026-02-03T13:00:00Z' }),
    };
    const s = computeStats(entries, new Date('2026-06-15T12:00:00Z'));
    const jan = s.aiStats.monthlyAvgScores.find((m) => m.month === 1);
    const feb = s.aiStats.monthlyAvgScores.find((m) => m.month === 2);
    expect(jan?.count).toBe(1);
    expect(feb?.count).toBe(1);
  });
});

// ── monthlyStats ─────────────────────────────────────────────────────────────

describe('computeStats — monthlyStats', () => {
  it('written conta apenas dias de semana com texto escrito', () => {
    const entries: EntriesStore = {
      '2026-01-05': makeEntry('2026-01-05'), // Monday
      '2026-01-06': makeEntry('2026-01-06'), // Tuesday
    };
    const s = computeStats(entries, TODAY_2026);
    const jan = s.monthlyStats.find((m) => m.month === 1)!;
    expect(jan.written).toBe(2);
  });

  it('total reflete o número de dias úteis do mês', () => {
    // Janeiro 2026 tem dias úteis Mon-Fri
    const s = computeStats({}, TODAY_2026);
    const jan = s.monthlyStats.find((m) => m.month === 1)!;
    // January 2026: 22 weekdays (Mon-Fri)
    expect(jan.total).toBeGreaterThan(0);
    expect(jan.total).toBeLessThanOrEqual(23);
  });

  it('monthlyStats totalWords soma palavras do mês', () => {
    const entries: EntriesStore = {
      '2026-01-05': makeEntry('2026-01-05', { wordCount: 120 }),
      '2026-01-06': makeEntry('2026-01-06', { wordCount: 80 }),
    };
    const s = computeStats(entries, TODAY_2026);
    const jan = s.monthlyStats.find((m) => m.month === 1)!;
    expect(jan.totalWords).toBe(200);
  });
});
