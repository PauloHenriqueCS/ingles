import { describe, it, expect } from 'vitest';
import { calculateReviewSchedule } from './reviewSchedule';

const BASE = new Date('2026-01-01T12:00:00Z');

function daysDiff(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

describe('calculateReviewSchedule', () => {
  it('nível 0 + passed → nível 1, 7 dias', () => {
    const r = calculateReviewSchedule({ currentLevel: 0, overallResult: 'passed', attemptedAt: BASE });
    expect(r.newLevel).toBe(1);
    expect(r.newStatus).toBe('scheduled');
    expect(r.intervalDays).toBe(7);
    expect(r.nextReviewAt).not.toBeNull();
    expect(daysDiff(BASE, r.nextReviewAt!)).toBe(7);
  });

  it('nível 1 + passed → nível 2, 21 dias', () => {
    const r = calculateReviewSchedule({ currentLevel: 1, overallResult: 'passed', attemptedAt: BASE });
    expect(r.newLevel).toBe(2);
    expect(r.newStatus).toBe('scheduled');
    expect(r.intervalDays).toBe(21);
    expect(daysDiff(BASE, r.nextReviewAt!)).toBe(21);
  });

  it('nível 2 + passed → nível 3, 60 dias', () => {
    const r = calculateReviewSchedule({ currentLevel: 2, overallResult: 'passed', attemptedAt: BASE });
    expect(r.newLevel).toBe(3);
    expect(r.newStatus).toBe('scheduled');
    expect(r.intervalDays).toBe(60);
    expect(daysDiff(BASE, r.nextReviewAt!)).toBe(60);
  });

  it('nível 3 + passed → nível 4, mastered', () => {
    const r = calculateReviewSchedule({ currentLevel: 3, overallResult: 'passed', attemptedAt: BASE });
    expect(r.newLevel).toBe(4);
    expect(r.newStatus).toBe('mastered');
    expect(r.nextReviewAt).toBeNull();
    expect(r.intervalDays).toBeNull();
  });

  it('nível 2 + failed → nível 0, 2 dias', () => {
    const r = calculateReviewSchedule({ currentLevel: 2, overallResult: 'failed', attemptedAt: BASE });
    expect(r.newLevel).toBe(0);
    expect(r.newStatus).toBe('scheduled');
    expect(r.intervalDays).toBe(2);
    expect(daysDiff(BASE, r.nextReviewAt!)).toBe(2);
  });

  it('nível 0 + failed → nível 0, 2 dias', () => {
    const r = calculateReviewSchedule({ currentLevel: 0, overallResult: 'failed', attemptedAt: BASE });
    expect(r.newLevel).toBe(0);
    expect(r.newStatus).toBe('scheduled');
    expect(r.intervalDays).toBe(2);
    expect(daysDiff(BASE, r.nextReviewAt!)).toBe(2);
  });

  it('usa UTC — não depende do fuso local', () => {
    const date = new Date('2026-01-31T23:59:00Z');
    const r = calculateReviewSchedule({ currentLevel: 0, overallResult: 'passed', attemptedAt: date });
    expect(r.nextReviewAt?.getUTCFullYear()).toBe(2026);
    expect(r.nextReviewAt?.getUTCMonth()).toBe(1); // fevereiro
    expect(r.nextReviewAt?.getUTCDate()).toBe(7);
  });

  it('nível 4 + passed → permanece mastered', () => {
    const r = calculateReviewSchedule({ currentLevel: 4, overallResult: 'passed', attemptedAt: BASE });
    expect(r.newLevel).toBe(4);
    expect(r.newStatus).toBe('mastered');
    expect(r.nextReviewAt).toBeNull();
    expect(r.intervalDays).toBeNull();
  });
});
