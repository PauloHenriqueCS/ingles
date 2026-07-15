import { describe, it, expect } from 'vitest';
import { resolveListeningCalendarStatus } from './resolve-listening-calendar-status';
import { buildListeningCalendarActivity } from './build-listening-calendar-activity';

describe('resolveListeningCalendarStatus', () => {
  it('undefined → coming_soon', () => {
    expect(resolveListeningCalendarStatus(undefined)).toBe('coming_soon');
  });

  it("'completed' → 'completed'", () => {
    expect(resolveListeningCalendarStatus('completed')).toBe('completed');
  });

  it("'in_progress' → 'in_progress'", () => {
    expect(resolveListeningCalendarStatus('in_progress')).toBe('in_progress');
  });

  it("'not_started' → 'not_started'", () => {
    expect(resolveListeningCalendarStatus('not_started')).toBe('not_started');
  });
});

describe('buildListeningCalendarActivity', () => {
  it('returns correct entry for completed status', () => {
    const entry = buildListeningCalendarActivity('2026-07-15', 'completed');
    expect(entry).toEqual({ date: '2026-07-15', listeningStatus: 'completed' });
  });

  it('returns correct entry for in_progress status', () => {
    const entry = buildListeningCalendarActivity('2026-07-15', 'in_progress');
    expect(entry).toEqual({ date: '2026-07-15', listeningStatus: 'in_progress' });
  });

  it('returns correct entry for not_started status', () => {
    const entry = buildListeningCalendarActivity('2026-07-14', 'not_started');
    expect(entry).toEqual({ date: '2026-07-14', listeningStatus: 'not_started' });
  });

  it('returns coming_soon when status is undefined', () => {
    const entry = buildListeningCalendarActivity('2026-07-16', undefined);
    expect(entry).toEqual({ date: '2026-07-16', listeningStatus: 'coming_soon' });
  });
});
