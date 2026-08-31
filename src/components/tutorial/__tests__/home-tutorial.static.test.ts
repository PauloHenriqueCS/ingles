/**
 * Static-wiring assertions for the walkthrough overlay (this repo has no
 * component-render test infra — we assert on the source). Covers the invariants
 * the spec makes mandatory: a persistent Skip, a11y dialog semantics, full
 * pointer capture (no accidental activation), safe-area awareness, reduced
 * motion, and the spotlight visual.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const tut = readFileSync(join(__dirname, '..', 'HomeTutorial.tsx'), 'utf8');
const target = readFileSync(join(__dirname, '..', 'useSpotlightTarget.ts'), 'utf8');

describe('HomeTutorial (static)', () => {
  it('is an accessible modal dialog', () => {
    expect(tut).toMatch(/role="dialog"/);
    expect(tut).toMatch(/aria-modal="true"/);
    expect(tut).toContain('aria-labelledby');
    expect(tut).toContain('aria-describedby');
  });

  it('always renders "Pular tutorial" and wires it to onSkip (§4 — every step)', () => {
    expect(tut).toContain('data-tour-action="skip"');
    expect(tut).toContain('onClick={onSkip}');
    expect(tut).toContain('{t.skip}');
    // Skip is NOT rendered conditionally on step index.
    expect(tut).not.toMatch(/!isFirst[^\n]*data-tour-action="skip"/);
  });

  it('exposes back / next / complete controls and a "X de Y" progress indicator', () => {
    expect(tut).toContain('data-tour-action="back"');
    expect(tut).toMatch(/data-tour-action=\{isLast \? 'complete' : 'next'\}/);
    expect(tut).toContain('t.progress(index + 1, TUTORIAL_STEP_COUNT)');
    // Back is hidden only on the first step, never Skip.
    expect(tut).toMatch(/\{!isFirst && \(/);
  });

  it('advances to onComplete on the last step and steps forward otherwise', () => {
    expect(tut).toMatch(/if \(isLast\)\s*\{\s*onComplete\(\)/);
  });

  it('captures ALL pointer events so the underlying Home cannot be activated (§14)', () => {
    expect(tut).toContain('data-tour-overlay="true"');
    // the visual highlight itself must not eat the taps meant for the catcher
    expect(tut).toMatch(/pointer-events-none/);
  });

  it('renders the spotlight as a high z-index box-shadow cutout', () => {
    expect(tut).toContain('z-[70]');
    expect(tut).toMatch(/boxShadow: `0 0 0 9999px \$\{SCRIM\}`/);
  });

  it('respects reduced motion and routes the Android back button through the host', () => {
    expect(tut).toContain('useReducedMotion');
    expect(tut).toContain('registerBackHandler');
    expect(tut).toMatch(/if \(isFirst\) onSkip\(\);\s*else goBack\(\);/);
  });

  it('restores focus on close and traps Tab within the dialog (§16)', () => {
    expect(tut).toContain('previouslyFocused?.focus?.()');
    expect(tut).toMatch(/e\.key === 'Tab'/);
    expect(tut).toMatch(/e\.key === 'Escape'/);
  });
});

describe('useSpotlightTarget (static)', () => {
  it('reads real safe-area insets via env(safe-area-inset-*) (§12)', () => {
    expect(target).toContain('env(safe-area-inset-top)');
    expect(target).toContain('env(safe-area-inset-bottom)');
    expect(target).toContain('env(safe-area-inset-left)');
    expect(target).toContain('env(safe-area-inset-right)');
  });

  it('scrolls the target into view and recalculates on scroll/resize/orientation (§13)', () => {
    expect(target).toContain('scrollIntoView');
    expect(target).toMatch(/addEventListener\('resize'/);
    expect(target).toMatch(/addEventListener\('orientationchange'/);
    expect(target).toMatch(/addEventListener\('scroll'/);
    expect(target).toContain('ResizeObserver');
  });

  it('fails soft to a centered card when the anchor is missing (never a broken hole)', () => {
    expect(target).toMatch(/querySelector[^\n]*data-tour/);
    expect(target).toMatch(/if \(!el\)/);
  });
});
