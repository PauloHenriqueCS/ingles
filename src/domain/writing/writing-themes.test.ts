import { describe, it, expect } from 'vitest';
import { WRITING_THEMES, resolveWritingThemeLabel, RANDOM_THEME_LABEL } from './writing-themes';

describe('WRITING_THEMES', () => {
  it('every option has a non-empty technical value and label', () => {
    for (const t of WRITING_THEMES) {
      expect(t.value.trim().length).toBeGreaterThan(0);
      expect(t.label.trim().length).toBeGreaterThan(0);
    }
  });

  it('technical values are unique', () => {
    const values = WRITING_THEMES.map((t) => t.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it('includes football_sports mapped to a football/sports label', () => {
    const t = WRITING_THEMES.find((x) => x.value === 'football_sports');
    expect(t?.label).toBe('Futebol e esportes');
  });
});

describe('resolveWritingThemeLabel', () => {
  it('resolves a known technical value to its Portuguese label', () => {
    expect(resolveWritingThemeLabel('football_sports')).toBe('Futebol e esportes');
    expect(resolveWritingThemeLabel('travel')).toBe('Viagens');
  });

  it('resolves every catalog entry correctly', () => {
    for (const t of WRITING_THEMES) {
      expect(resolveWritingThemeLabel(t.value)).toBe(t.label);
    }
  });

  it('returns null for null/undefined/empty (random theme)', () => {
    expect(resolveWritingThemeLabel(null)).toBeNull();
    expect(resolveWritingThemeLabel(undefined)).toBeNull();
    expect(resolveWritingThemeLabel('')).toBeNull();
  });

  it('returns null for an unknown value instead of inventing a label', () => {
    expect(resolveWritingThemeLabel('not_a_real_theme')).toBeNull();
  });

  it('never returns the literal random-theme label for a real technical value', () => {
    for (const t of WRITING_THEMES) {
      expect(resolveWritingThemeLabel(t.value)).not.toBe(RANDOM_THEME_LABEL);
    }
  });
});
