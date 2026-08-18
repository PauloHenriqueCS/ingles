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
  it('never sends a user-picked theme — mission is curriculum-driven only', () => {
    const body = buildGenerateThemeRequestBody(BASE_INPUT);
    // The manual theme selection was removed; no `theme` field must be emitted,
    // so nothing can compete with the daily curricular recorte on the server.
    expect('theme' in body).toBe(false);
  });

  it('preserves the other request fields verbatim', () => {
    const body = buildGenerateThemeRequestBody({
      mode: 'review',
      reviewGroup: { group: { id: 'g1' }, items: [] },
      learningContext: { currentLevel: 'A2' },
      previousThemeId: 'prev-1',
      excludedTheme: { title: 'x' },
    });
    expect(body).toEqual({
      mode: 'review',
      reviewGroup: { group: { id: 'g1' }, items: [] },
      learningContext: { currentLevel: 'A2' },
      previousThemeId: 'prev-1',
      excludedTheme: { title: 'x' },
    });
  });
});
