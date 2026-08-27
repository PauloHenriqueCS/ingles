/**
 * Static wiring guards for the Writing flow's mission STATE ISOLATION and the
 * "Nova missão" (multiple practices/day) action, under the redesigned stepper
 * flow. The node test env has no DOM, so these lock the wiring at the source
 * level:
 *  - each new mission starts from a fully blank writing/review surface (nothing
 *    from the previous mission leaks in — título, ideia, texto, análise, Versão
 *    2, reviewId, and the flow step/position);
 *  - the reset only touches local state (never generates, reviews, consumes, or
 *    mutates history);
 *  - restoring today's mission on entry does NOT reset the surface;
 *  - the "Nova missão" action is server-authoritative (canOfferNewWriting) and,
 *    in the new flow, is offered on the Concluído step (DoneStep), not a sticky
 *    banner.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const view = readFileSync(join(__dirname, '..', 'DayView.tsx'), 'utf8');
const card = readFileSync(join(__dirname, '..', 'DailyThemeCard.tsx'), 'utf8');

function fnBody(src: string, decl: string): string {
  const start = src.indexOf(decl);
  expect(start).toBeGreaterThan(-1);
  const rest = src.slice(start + decl.length);
  const nextFn = rest.search(/\n {2}(?:async )?function /);
  return decl + (nextFn === -1 ? rest : rest.slice(0, nextFn));
}

describe('DayView — "Nova missão" server-authoritative gate', () => {
  it('gates the action on the server-authoritative entitlement (canOfferNewWriting → reviews.canStart)', () => {
    expect(view).toMatch(/canOfferNewWriting\(writingEntitlements, writingDisabledByPlan\)/);
    expect(view).toMatch(/onClick=\{handleNewMission\}|onNewMission=\{handleNewMission\}/);
  });
});

describe('DayView — per-mission state isolation (reset)', () => {
  it('resetWritingState clears the ENTIRE writing/review surface and resets the flow position', () => {
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
    // New flow: the reset also returns the stepper to the first step.
    expect(body).toMatch(/setStep\('mission'\)/);
    expect(body).toMatch(/setFurthestSlot\('mission'\)/);
    // Pure local-state reset: no network, no review, no history mutation.
    expect(body).not.toMatch(/\bfetch\(/);
    expect(body).not.toMatch(/handleReview\(/);
    expect(body).not.toMatch(/\.refetch\(/);
  });

  it('handleNewMission resets the surface, re-opens mission selection, and refreshes quota — never generates/reviews', () => {
    const body = fnBody(view, 'function handleNewMission');
    expect(body).toMatch(/freshPracticeRef\.current = true/);
    expect(body).toMatch(/resetWritingState\(\)/);
    expect(body).toMatch(/setDailyTheme\(null\)/);
    expect(body).toMatch(/entitlements\.refetch\(\)/);
    expect(body).not.toMatch(/handleReview\(/);
    expect(body).not.toMatch(/\bfetch\(/);
  });

  it('handleNewMission is a DURABLE reset: supersedes the old mission and blanks the day entry (so a reload lands on Missão, not the old Concluído)', () => {
    const body = fnBody(view, 'function handleNewMission');
    // supersede the previous mission server-side so retrieve returns nothing
    expect(body).toMatch(/discardCurrentMission\(\)/);
    // blank the stored entry (status nao-iniciado, no review) so a reload
    // re-derives the Missão step instead of restoring the concluded state
    expect(body).toMatch(/onSave\(\{/);
    expect(body).toMatch(/status: 'nao-iniciado'/);
    expect(body).toMatch(/aiReview: null/);
    // this session owns the step; guard against re-hydration/auto-restore
    expect(body).toMatch(/hydratedRef\.current = date/);
    expect(body).toMatch(/themeRestoreStartedRef\.current = true/);
  });

  it('DailyThemeCard is told to suppress restore during a fresh practice (so remount never brings the old mission back)', () => {
    expect(view).toMatch(/suppressRestore=\{freshPracticeRef\.current\}/);
    // and the card actually honors it: skips the mount retrieve
    expect(card).toMatch(/if \(suppressRestore\) \{ setRestoring\(false\); return; \}/);
  });

  it('handleMissionGenerated adopts the NEW mission AND resets the surface (identity fix)', () => {
    const body = fnBody(view, 'function handleMissionGenerated');
    expect(body).toMatch(/freshPracticeRef\.current = true/);
    expect(body).toMatch(/resetWritingState\(\)/);
    expect(body).toMatch(/setDailyTheme\(newTheme\)/);
    expect(body).toMatch(/entitlements\.refetch\(\)/);
    expect(body.indexOf('resetWritingState()')).toBeLessThan(body.indexOf('setDailyTheme(newTheme)'));
    expect(body).not.toMatch(/\bfetch\(/);
  });

  it('a fresh extra practice is not clobbered by the day\'s stored entry', () => {
    expect(view).toMatch(/if \(freshPracticeRef\.current\) return;/);
    expect(view).toMatch(/freshPracticeRef\.current = false;/);
  });
});

describe('DayView ↔ DailyThemeCard — generation resets, restore does not', () => {
  it('a newly generated mission goes through onMissionGenerated (resets); restore uses onThemeReady (no reset)', () => {
    expect(view).toMatch(/onMissionGenerated=\{handleMissionGenerated\}/);
    // The restore callback only swaps the theme + refetches — it must NOT call
    // resetWritingState (which would wipe the restored writing/review surface).
    expect(view).toMatch(/onThemeReady=\{\([a-zA-Z0-9]+\) => \{ setDailyTheme\([a-zA-Z0-9]+\); entitlements\.refetch\(\); \}\}/);
    const restoreLine = view.split('\n').find((l) => l.includes('onThemeReady=')) ?? '';
    expect(restoreLine).not.toMatch(/resetWritingState/);
  });

  it('DailyThemeCard.generate() emits onMissionGenerated, and the mount-restore emits onThemeReady', () => {
    const restoreEffect = card.slice(
      card.indexOf("body: JSON.stringify({ mode: 'retrieve' })") - 200,
      card.indexOf("body: JSON.stringify({ mode: 'retrieve' })") + 400,
    );
    expect(restoreEffect).toMatch(/onThemeReady\(/);
    expect(restoreEffect).not.toMatch(/onMissionGenerated\(/);
    const generate = card.slice(card.indexOf('async function generate'));
    expect(generate).toMatch(/onMissionGenerated\(\{/);
    expect(generate).not.toMatch(/onThemeReady\(/);
  });
});

describe('DayView — "Nova missão" is offered on the Concluído step (not a sticky banner)', () => {
  it('DoneStep receives the same server-authoritative gate and the shared handler', () => {
    expect(view).toMatch(/const canStartNewWriting = canOfferNewWriting\(writingEntitlements, writingDisabledByPlan\);/);
    // The completion screen owns the "Nova missão" affordance now.
    expect(view).toMatch(/<DoneStep/);
    expect(view).toMatch(/canStartNewWriting=\{canStartNewWriting\}/);
    expect(view).toMatch(/onNewMission=\{handleNewMission\}/);
  });
});
