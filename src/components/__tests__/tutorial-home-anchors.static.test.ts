/**
 * The walkthrough spotlights Home/header elements by STABLE data-tour anchors
 * (§11) — never text/nth-child/Tailwind. This guards that every anchor a step
 * references actually exists on the rendered Home, so a refactor that drops one
 * fails a test instead of silently breaking the spotlight.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TUTORIAL_STEPS } from '../tutorial/tutorialSteps';

const home = readFileSync(join(__dirname, '..', 'HomePage.tsx'), 'utf8');
const header = readFileSync(join(__dirname, '..', 'AppHeader.tsx'), 'utf8');
const combined = home + header;

describe('Home tutorial anchors', () => {
  it('places every spotlight step anchor on a real Home/header element', () => {
    const anchors = TUTORIAL_STEPS.map((s) => s.anchor).filter((a): a is string => a !== null);
    for (const anchor of anchors) {
      expect(combined).toContain(`data-tour="${anchor}"`);
    }
  });

  it('anchors current-focus, recommended-practice, practice-list and error-review in the Home', () => {
    expect(home).toContain('data-tour="current-focus"');
    expect(home).toContain('data-tour="recommended-practice"');
    expect(home).toContain('data-tour="practice-list"');
    expect(home).toContain('data-tour="error-review"');
  });

  it('anchors the main menu on the header hamburger', () => {
    expect(header).toContain('data-tour="main-menu"');
    // still the menu-opening button (design untouched)
    expect(header).toMatch(/onClick=\{onMenuOpen\}[\s\S]*data-tour="main-menu"/);
  });
});
