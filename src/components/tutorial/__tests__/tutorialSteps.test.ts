import { describe, it, expect } from 'vitest';
import { TUTORIAL_STEPS, TUTORIAL_STEP_COUNT } from '../tutorialSteps';

describe('tutorialSteps', () => {
  it('defines exactly 7 steps (§5)', () => {
    expect(TUTORIAL_STEP_COUNT).toBe(7);
    expect(TUTORIAL_STEPS).toHaveLength(7);
  });

  it('runs in the intended order welcome → focus → recommended → practices → errors → progress → ready', () => {
    expect(TUTORIAL_STEPS.map((s) => s.id)).toEqual([
      'welcome',
      'focus',
      'recommended',
      'practices',
      'errors',
      'progress',
      'ready',
    ]);
  });

  it('anchors each spotlight step to a stable data-tour value, and centers the first/last', () => {
    const byId = Object.fromEntries(TUTORIAL_STEPS.map((s) => [s.id, s.anchor]));
    expect(byId.welcome).toBeNull();
    expect(byId.focus).toBe('current-focus');
    expect(byId.recommended).toBe('recommended-practice');
    expect(byId.practices).toBe('practice-list');
    expect(byId.errors).toBe('error-review');
    expect(byId.progress).toBe('main-menu');
    expect(byId.ready).toBeNull();
  });
});
