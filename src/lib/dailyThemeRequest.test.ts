import { describe, it, expect } from 'vitest';
import { buildGenerateThemeRequestBody } from './dailyThemeRequest';

const BASE_INPUT = {
  mode: 'normal' as const,
  reviewGroup: null,
  learningContext: { currentLevel: 'B1' },
  previousThemeId: null,
  excludedTheme: null,
};

describe('buildGenerateThemeRequestBody', () => {
  it('sends the selected technical theme value under "theme"', () => {
    const body = buildGenerateThemeRequestBody({ ...BASE_INPUT, selectedTheme: 'football_sports' });
    expect(body.theme).toBe('football_sports');
  });

  it('sends theme: null for "Tema aleatório" (no selection) — matches prior behavior', () => {
    const body = buildGenerateThemeRequestBody({ ...BASE_INPUT, selectedTheme: null });
    expect(body.theme).toBeNull();
  });

  it('does not alter the other existing fields of the request', () => {
    const body = buildGenerateThemeRequestBody({
      mode: 'review',
      reviewGroup: { group: { id: 'g1' }, items: [] },
      learningContext: { currentLevel: 'A2' },
      previousThemeId: 'prev-1',
      excludedTheme: { title: 'x' },
      selectedTheme: 'music',
    });
    expect(body).toEqual({
      mode: 'review',
      reviewGroup: { group: { id: 'g1' }, items: [] },
      learningContext: { currentLevel: 'A2' },
      previousThemeId: 'prev-1',
      excludedTheme: { title: 'x' },
      theme: 'music',
    });
  });

  it('sends the raw technical value, never a pre-translated label', () => {
    const body = buildGenerateThemeRequestBody({ ...BASE_INPUT, selectedTheme: 'football_sports' });
    expect(body.theme).not.toBe('Futebol e esportes');
    expect(body.theme).toBe('football_sports');
  });
});
