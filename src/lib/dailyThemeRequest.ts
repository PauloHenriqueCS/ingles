/**
 * Pure request-body builder for POST /api/generate-theme, extracted out of
 * DailyThemeCard so the "does the selected theme actually reach the request
 * body" behavior is unit-testable without rendering the component.
 */

export interface GenerateThemeRequestInput {
  mode: 'normal' | 'review';
  reviewGroup: unknown | null;
  learningContext: unknown;
  previousThemeId: string | null;
  excludedTheme: unknown | null;
  /** Technical value from the theme select (e.g. 'football_sports'), or null for "Tema aleatório". */
  selectedTheme: string | null;
}

export interface GenerateThemeRequestBody {
  mode: 'normal' | 'review';
  reviewGroup: unknown | null;
  learningContext: unknown;
  previousThemeId: string | null;
  excludedTheme: unknown | null;
  theme: string | null;
}

export function buildGenerateThemeRequestBody(input: GenerateThemeRequestInput): GenerateThemeRequestBody {
  return {
    mode: input.mode,
    reviewGroup: input.reviewGroup,
    learningContext: input.learningContext,
    previousThemeId: input.previousThemeId,
    excludedTheme: input.excludedTheme,
    theme: input.selectedTheme,
  };
}
