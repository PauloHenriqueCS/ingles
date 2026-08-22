/**
 * Static wiring guards for the Writing "Nova missão" (multiple practices/day) and
 * for per-mission STATE ISOLATION. The node test env has no DOM, so these lock the
 * wiring at the source level:
 *  - each new mission starts from a fully blank writing/review surface (nothing
 *    from the previous mission leaks in — título, ideia, texto, análise, Versão 2,
 *    estado "Revisado", reviewId);
 *  - the reset only touches local state (never generates, reviews, consumes, or
 *    mutates history);
 *  - restoring today's mission on entry does NOT reset the surface (its stored
 *    writing/review belongs to that mission);
 *  - the action is server-authoritative (canOfferNewWriting / reviews.canStart);
 *  - the action is reachable from the TOP of the screen once the mission is
 *    reviewed, not only at the bottom.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const view = readFileSync(join(__dirname, '..', 'DayView.tsx'), 'utf8');
const card = readFileSync(join(__dirname, '..', 'DailyThemeCard.tsx'), 'utf8');

function fnBody(src: string, decl: string): string {
  const start = src.indexOf(decl);
  expect(start).toBeGreaterThan(-1);
  // Cut at the next (async) function declaration so the slice is exactly this
  // function's body and never bleeds into the following one.
  const rest = src.slice(start + decl.length);
  const nextFn = rest.search(/\n {2}(?:async )?function /);
  return decl + (nextFn === -1 ? rest : rest.slice(0, nextFn));
}

describe('DayView — "Nova missão" server-authoritative gate', () => {
  it('gates the action on the server-authoritative entitlement (canOfferNewWriting → reviews.canStart)', () => {
    expect(view).toMatch(/canOfferNewWriting\(writingEntitlements, writingDisabledByPlan\)/);
    expect(view).toMatch(/Nova missão/);
    expect(view).toMatch(/onClick=\{handleNewMission\}/);
  });
});

describe('DayView — per-mission state isolation (reset)', () => {
  it('resetWritingState clears the ENTIRE writing/review surface', () => {
    const body = fnBody(view, 'function resetWritingState');
    expect(body).toMatch(/setTitle\(''\)/);
    expect(body).toMatch(/setOriginalText\(''\)/);
    expect(body).toMatch(/setPtDraft\(''\)/);
    expect(body).toMatch(/setDifficulty\(null\)/);
    expect(body).toMatch(/setStatus\('nao-iniciado'\)/);
    expect(body).toMatch(/setAiReview\(null\)/);
    expect(body).toMatch(/setReviewedAt\(null\)/);
    expect(body).toMatch(/setReviewState\('idle'\)/);
    expect(body).toMatch(/setReviewId\(null\)/);
    expect(body).toMatch(/setExistingV2Text\(null\)/);
    expect(body).toMatch(/setExistingV2Comparison\(null\)/);
    expect(body).toMatch(/setExistingV2FinalText\(null\)/);
    // Pure local-state reset: no network, no review, no history mutation.
    expect(body).not.toMatch(/\bfetch\(/);
    expect(body).not.toMatch(/handleReview\(/);
    expect(body).not.toMatch(/\.refetch\(/); // refetch belongs to the callers, not the reset
  });

  it('handleNewMission resets the surface, re-opens mission selection, and refreshes quota — never generates/reviews', () => {
    const body = fnBody(view, 'function handleNewMission');
    expect(body).toMatch(/freshPracticeRef\.current = true/);
    expect(body).toMatch(/resetWritingState\(\)/);
    expect(body).toMatch(/setDailyTheme\(null\)/); // re-open "Receber missão"
    expect(body).toMatch(/entitlements\.refetch\(\)/);
    expect(body).not.toMatch(/handleReview\(/);
    expect(body).not.toMatch(/\bfetch\(/);
  });

  it('handleMissionGenerated adopts the NEW mission AND resets the surface (identity fix)', () => {
    const body = fnBody(view, 'function handleMissionGenerated');
    // A brand-new mission owns the screen and never inherits the previous one.
    expect(body).toMatch(/freshPracticeRef\.current = true/);
    expect(body).toMatch(/resetWritingState\(\)/);
    expect(body).toMatch(/setDailyTheme\(newTheme\)/);
    expect(body).toMatch(/entitlements\.refetch\(\)/);
    // The reset must run BEFORE (or with) adopting the new theme, so no stale
    // report can render against the new mission.
    expect(body.indexOf('resetWritingState()')).toBeLessThan(body.indexOf('setDailyTheme(newTheme)'));
    expect(body).not.toMatch(/\bfetch\(/);
  });

  it('a fresh extra practice is not clobbered by the day\'s stored entry', () => {
    expect(view).toMatch(/if \(freshPracticeRef\.current\) return;/);
    // Cleared on day navigation so a new day restores normally.
    expect(view).toMatch(/freshPracticeRef\.current = false;/);
  });
});

describe('DayView ↔ DailyThemeCard — generation resets, restore does not', () => {
  it('a newly generated mission goes through onMissionGenerated (resets); restore uses onThemeReady (no reset)', () => {
    // Wiring in DayView: the generation callback is handleMissionGenerated.
    expect(view).toMatch(/onMissionGenerated=\{handleMissionGenerated\}/);
    // The restore callback only swaps the theme (no resetWritingState in it).
    expect(view).toMatch(/onThemeReady=\{\(t\) => \{ setDailyTheme\(t\); entitlements\.refetch\(\); \}\}/);
  });

  it('DailyThemeCard.generate() emits onMissionGenerated, and the mount-restore emits onThemeReady', () => {
    // The mount-restore (retrieve) path re-hydrates via onThemeReady.
    const restoreEffect = card.slice(
      card.indexOf("body: JSON.stringify({ mode: 'retrieve' })") - 200,
      card.indexOf("body: JSON.stringify({ mode: 'retrieve' })") + 400,
    );
    expect(restoreEffect).toMatch(/onThemeReady\(/);
    expect(restoreEffect).not.toMatch(/onMissionGenerated\(/);
    // The explicit generate() path (new mission) emits onMissionGenerated.
    const generate = card.slice(card.indexOf('async function generate'));
    expect(generate).toMatch(/onMissionGenerated\(\{/);
    expect(generate).not.toMatch(/onThemeReady\(/);
  });
});

describe('DayView — "Nova missão" is reachable from the top after completion', () => {
  it('renders a top action gated by a completed mission AND the daily quota', () => {
    expect(view).toMatch(/const missionReviewed = reviewState === 'done' && !!aiReview;/);
    expect(view).toMatch(/const canStartNewWriting = canOfferNewWriting\(writingEntitlements, writingDisabledByPlan\);/);
    // A sticky top banner, gated by both conditions, invoking the same handler.
    expect(view).toMatch(/\{missionReviewed && canStartNewWriting && \(/);
    expect(view).toMatch(/sticky top-0/);
  });
});
