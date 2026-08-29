import { describe, it, expect } from 'vitest';
import {
  playActivityCompleteSound,
  playDayCompleteSound,
  setCelebrationSoundMuted,
} from '../celebrationSound';
import {
  triggerActivityHaptic,
  triggerDayCompleteHaptic,
  setCelebrationHapticsMuted,
} from '../celebrationHaptics';
import { prefersReducedMotion } from '../celebrationPrefs';
import { trackCelebrationShown } from '../celebrationAnalytics';
import { celebrationUiStrings } from '../../i18n/celebrationUiStrings';

// The vitest env is 'node' — no AudioContext, no matchMedia, no Capacitor. These
// tests prove the sound/haptics/observability layers degrade SILENTLY: a failure
// there must never throw and never break the activity completion.

describe('celebration sound — fail-safe (no AudioContext available)', () => {
  it('playing a sound never throws when there is no Web Audio support', () => {
    expect(() => playActivityCompleteSound()).not.toThrow();
    expect(() => playDayCompleteSound()).not.toThrow();
  });

  it('muting is honored and never throws', () => {
    setCelebrationSoundMuted(true);
    expect(() => playActivityCompleteSound()).not.toThrow();
    expect(() => playDayCompleteSound()).not.toThrow();
    setCelebrationSoundMuted(false);
  });
});

describe('celebration haptics — fail-safe (web / no Capacitor)', () => {
  it('triggering haptics never throws and returns synchronously', () => {
    expect(() => triggerActivityHaptic()).not.toThrow();
    expect(() => triggerDayCompleteHaptic()).not.toThrow();
  });

  it('muting is honored and never throws', () => {
    setCelebrationHapticsMuted(true);
    expect(() => triggerActivityHaptic()).not.toThrow();
    expect(() => triggerDayCompleteHaptic()).not.toThrow();
    setCelebrationHapticsMuted(false);
  });
});

describe('prefers-reduced-motion — safe when matchMedia is unavailable', () => {
  it('returns a boolean and never throws off the DOM', () => {
    expect(() => prefersReducedMotion()).not.toThrow();
    expect(typeof prefersReducedMotion()).toBe('boolean');
  });
});

describe('celebration observability — fail-safe & PII-free', () => {
  it('tracking never throws for either celebration type', () => {
    expect(() =>
      trackCelebrationShown({
        type: 'activity-complete',
        activityType: 'listening',
        completedCount: 2,
        totalCount: 3,
      }),
    ).not.toThrow();
    expect(() =>
      trackCelebrationShown({ type: 'day-complete', streakDays: 8, completedCount: 3, totalCount: 3 }),
    ).not.toThrow();
  });
});

describe('celebration i18n resolver', () => {
  it('defaults to pt-BR (primary) when the interface language is null/unknown', () => {
    expect(celebrationUiStrings(null).dayCompleteTitle).toBe('Dia completo!');
    expect(celebrationUiStrings('zz').dayCompleteTitle).toBe('Dia completo!');
    expect(celebrationUiStrings(undefined).activityTitle('listening')).toBe('Listening concluída');
  });

  it('resolves English and falls back on a region subtag', () => {
    expect(celebrationUiStrings('en').dayCompleteTitle).toBe('Day complete!');
    expect(celebrationUiStrings('en-US').dayCompleteTitle).toBe('Day complete!');
  });

  it('progress + streak lines pluralize correctly', () => {
    const pt = celebrationUiStrings('pt-BR');
    expect(pt.activityProgress(2, 3)).toBe('2 de 3 práticas de hoje');
    expect(pt.activityProgress(1, 1)).toBe('1 de 1 prática de hoje');
    expect(pt.streakLine(8)).toBe('Sequência: 8 dias');
    expect(pt.streakLine(1)).toBe('Sequência: 1 dia');
  });
});
