/**
 * Pure, render-free definition of the first-run Home tutorial steps. Kept as data
 * (no JSX, no i18n) so the sequence, anchors and count are unit-testable and the
 * overlay component maps each step id → localized content + visuals.
 *
 * Anchors are STABLE `data-tour` attribute values placed on Home/header elements
 * (§11) — never text, nth-child, or Tailwind classes. `null` anchor = a centered
 * card with no spotlight (steps 1 and 7).
 */

export type TutorialAnchor =
  | 'current-focus'
  | 'recommended-practice'
  | 'practice-list'
  | 'error-review'
  | 'main-menu'
  | null;

export interface TutorialStepDef {
  /** Stable id — maps to localized content in the overlay and is safe for tests. */
  id: 'welcome' | 'focus' | 'recommended' | 'practices' | 'errors' | 'progress' | 'ready';
  /** data-tour value to spotlight, or null for a centered (no-spotlight) card. */
  anchor: TutorialAnchor;
}

export const TUTORIAL_STEPS: readonly TutorialStepDef[] = [
  { id: 'welcome', anchor: null },
  { id: 'focus', anchor: 'current-focus' },
  { id: 'recommended', anchor: 'recommended-practice' },
  { id: 'practices', anchor: 'practice-list' },
  { id: 'errors', anchor: 'error-review' },
  { id: 'progress', anchor: 'main-menu' },
  { id: 'ready', anchor: null },
] as const;

export const TUTORIAL_STEP_COUNT = TUTORIAL_STEPS.length;
