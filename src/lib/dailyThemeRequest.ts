/**
 * Pure request-body builder for POST /api/generate-theme, extracted out of
 * DailyThemeCard so the request shape stays unit-testable without rendering the
 * component.
 *
 * NOTE: manual theme selection was removed — the daily writing mission is
 * determined exclusively by the user's teaching plan / current level / daily
 * curricular recorte on the server. No user-picked topic is sent.
 */

export interface GenerateThemeRequestInput {
  mode: 'normal' | 'review';
  reviewGroup: unknown | null;
  learningContext: unknown;
  previousThemeId: string | null;
  excludedTheme: unknown | null;
}

export interface GenerateThemeRequestBody {
  mode: 'normal' | 'review';
  reviewGroup: unknown | null;
  learningContext: unknown;
  previousThemeId: string | null;
  excludedTheme: unknown | null;
}

export function buildGenerateThemeRequestBody(input: GenerateThemeRequestInput): GenerateThemeRequestBody {
  return {
    mode: input.mode,
    reviewGroup: input.reviewGroup,
    learningContext: input.learningContext,
    previousThemeId: input.previousThemeId,
    excludedTheme: input.excludedTheme,
  };
}
