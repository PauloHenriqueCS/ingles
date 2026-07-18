import { describe, it, expect } from 'vitest';
import {
  formatDailyRemaining,
  formatSecondsAsMinSec,
  formatMonthlyRemaining,
  formatExtraMinutesRemaining,
  formatClock,
} from './entitlement-formatting';

describe('formatDailyRemaining', () => {
  it('uses singular noun and "restante" for 1', () => {
    expect(formatDailyRemaining(1, 'geração', 'gerações')).toBe('1 geração restante hoje');
  });
  it('uses plural noun and "restantes" for 2+', () => {
    expect(formatDailyRemaining(2, 'geração', 'gerações')).toBe('2 gerações restantes hoje');
  });
  it('uses plural noun and "restantes" for 0', () => {
    expect(formatDailyRemaining(0, 'revisão', 'revisões')).toBe('0 revisões restantes hoje');
  });
});

describe('formatSecondsAsMinSec', () => {
  it('formats whole minutes with no seconds', () => {
    expect(formatSecondsAsMinSec(600)).toBe('10 min');
  });
  it('formats minutes and seconds', () => {
    expect(formatSecondsAsMinSec(512)).toBe('8 min 32 s');
  });
  it('formats seconds only under a minute', () => {
    expect(formatSecondsAsMinSec(45)).toBe('45 s');
  });
  it('never goes negative', () => {
    expect(formatSecondsAsMinSec(-10)).toBe('0 s');
  });
});

describe('formatMonthlyRemaining / formatExtraMinutesRemaining', () => {
  it('appends the monthly suffix', () => {
    expect(formatMonthlyRemaining(512)).toBe('8 min 32 s restantes neste mês');
  });
  it('appends the extra-minutes suffix', () => {
    expect(formatExtraMinutesRemaining(200)).toBe('3 min 20 s restantes em minutos extras');
  });
});

describe('formatClock', () => {
  it('pads single-digit minutes and seconds', () => {
    expect(formatClock(12)).toBe('00:12');
    expect(formatClock(30)).toBe('00:30');
  });
  it('formats minutes correctly past 60 seconds', () => {
    expect(formatClock(90)).toBe('01:30');
  });
});
