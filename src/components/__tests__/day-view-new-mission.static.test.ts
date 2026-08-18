/**
 * Static wiring guards for the Writing "Nova missão" (multiple practices/day).
 * The node test env has no DOM, so these lock the wiring at the source level:
 * the action is server-authoritative (canOfferNewWriting / reviews.canStart), it
 * only resets local state (never generates or consumes by itself), and a fresh
 * extra practice is not clobbered by the day's stored entry.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const view = readFileSync(join(__dirname, '..', 'DayView.tsx'), 'utf8');

describe('DayView — "Nova missão" wiring', () => {
  it('gates the action on the server-authoritative entitlement (canOfferNewWriting → reviews.canStart)', () => {
    expect(view).toMatch(/canOfferNewWriting\(writingEntitlements, writingDisabledByPlan\)/);
    expect(view).toMatch(/Nova missão/);
    expect(view).toMatch(/onClick=\{handleNewMission\}/);
  });

  it('handleNewMission only RESETS local state — it never generates a mission or submits a review', () => {
    const start = view.indexOf('function handleNewMission');
    expect(start).toBeGreaterThan(-1);
    const body = view.slice(start, start + 900);
    // Resets the practice to blank.
    expect(body).toMatch(/setDailyTheme\(null\)/);
    expect(body).toMatch(/setOriginalText\(''\)/);
    expect(body).toMatch(/setReviewId\(null\)/);
    expect(body).toMatch(/setStatus\('nao-iniciado'\)/);
    expect(body).toMatch(/freshPracticeRef\.current = true/);
    // Refreshes the server-authoritative quota, but does NOT itself generate or review.
    expect(body).toMatch(/entitlements\.refetch\(\)/);
    expect(body).not.toMatch(/handleReview\(/);
    // No direct network call in the reset (\b so it doesn't match refetch()).
    expect(body).not.toMatch(/\bfetch\(/);
  });

  it('a fresh extra practice is not clobbered by the day\'s stored entry', () => {
    // The entry-restore effect early-returns while a fresh practice is active.
    expect(view).toMatch(/if \(freshPracticeRef\.current\) return;/);
    // The flag is cleared on day navigation so a new day restores normally.
    expect(view).toMatch(/freshPracticeRef\.current = false;/);
  });
});
