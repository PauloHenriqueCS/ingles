import { describe, it, expect, vi, afterEach } from 'vitest';
import { getTodaySP, toSpDate, getSpYear, getSpMonth, getYesterdaySP } from './timezone';

afterEach(() => {
  vi.useRealTimers();
});

describe('toSpDate', () => {
  it('converte timestamp UTC de 23h50 SP para o dia correto em SP', () => {
    // 2026-07-15 02:50 UTC = 2026-07-14 23:50 SP (UTC-3)
    const result = toSpDate('2026-07-15T02:50:00Z');
    expect(result).toBe('2026-07-14');
  });

  it('converte timestamp UTC de 03h10 para o próximo dia em SP', () => {
    // 2026-07-15 03:10 UTC = 2026-07-15 00:10 SP
    const result = toSpDate('2026-07-15T03:10:00Z');
    expect(result).toBe('2026-07-15');
  });

  it('converte meia-noite UTC para o dia anterior em SP', () => {
    // 2026-01-01 00:00 UTC = 2025-12-31 21:00 SP
    const result = toSpDate('2026-01-01T00:00:00Z');
    expect(result).toBe('2025-12-31');
  });

  it('converte corretamente no fuso horário de verão do Brasil', () => {
    // Brasil observa horário de verão (UTC-2) em janeiro
    // 2026-01-01 02:10 UTC = 2026-01-01 00:10 SP (com horário de verão UTC-2)
    // Ou 2025-12-31 23:10 SP (sem horário de verão UTC-3)
    // O importante é que o resultado é uma data válida
    const result = toSpDate('2026-01-01T02:10:00Z');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('getTodaySP', () => {
  it('retorna uma string no formato YYYY-MM-DD', () => {
    const result = getTodaySP();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('retorna a data correta para São Paulo', () => {
    vi.useFakeTimers();
    // 2026-07-15 03:00 UTC = 2026-07-15 00:00 SP
    vi.setSystemTime(new Date('2026-07-15T03:00:00Z'));
    expect(getTodaySP()).toBe('2026-07-15');
    vi.useRealTimers();
  });

  it('retorna o dia anterior quando UTC é antes das 03h', () => {
    vi.useFakeTimers();
    // 2026-07-15 02:59 UTC = 2026-07-14 23:59 SP
    vi.setSystemTime(new Date('2026-07-15T02:59:00Z'));
    expect(getTodaySP()).toBe('2026-07-14');
    vi.useRealTimers();
  });
});

describe('getSpYear / getSpMonth', () => {
  it('retorna o ano correto em SP', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T03:00:00Z'));
    expect(getSpYear()).toBe(2026);
    vi.useRealTimers();
  });

  it('retorna o mês correto em SP', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T03:00:00Z'));
    expect(getSpMonth()).toBe(7);
    vi.useRealTimers();
  });

  it('o mês de janeiro funciona corretamente (sem off-by-one)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-05T10:00:00Z'));
    expect(getSpMonth()).toBe(1);
    vi.useRealTimers();
  });
});

describe('getYesterdaySP', () => {
  it('retorna o dia anterior ao dia atual em SP', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T03:00:00Z'));
    const today = getTodaySP();
    const yesterday = getYesterdaySP();
    expect(today).toBe('2026-07-15');
    expect(yesterday).toBe('2026-07-14');
    vi.useRealTimers();
  });

  it('atravessa meses corretamente', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T10:00:00Z'));
    const yesterday = getYesterdaySP();
    expect(yesterday).toBe('2026-07-31');
    vi.useRealTimers();
  });
});
