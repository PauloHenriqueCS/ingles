/**
 * Canonical catalog of writing mission themes — the single source of truth
 * for both the theme <select> (frontend) and the technical-value → label
 * conversion used to build the AI prompt (backend). Never duplicate this
 * list elsewhere.
 */

export interface WritingThemeOption {
  /** Technical value sent over the wire and used in the select's <option>. */
  value: string;
  /** Portuguese label shown to the user and used in the AI prompt. */
  label: string;
}

export const WRITING_THEMES: WritingThemeOption[] = [
  { value: 'travel', label: 'Viagens' },
  { value: 'work_career', label: 'Trabalho e carreira' },
  { value: 'daily_life', label: 'Vida cotidiana' },
  { value: 'movies_series', label: 'Filmes e séries' },
  { value: 'music', label: 'Música' },
  { value: 'football_sports', label: 'Futebol e esportes' },
  { value: 'technology', label: 'Tecnologia' },
  { value: 'food_restaurants', label: 'Comida e restaurantes' },
  { value: 'relationships_social_life', label: 'Relacionamentos e vida social' },
  { value: 'health_wellbeing', label: 'Saúde e bem-estar' },
  { value: 'money_shopping', label: 'Dinheiro e compras' },
  { value: 'mystery_adventure', label: 'Mistério e aventura' },
];

/** Label shown for the "no theme constraint" option in the select. */
export const RANDOM_THEME_LABEL = 'Tema aleatório';

/**
 * Resolves a technical theme value (e.g. 'football_sports') to its
 * Portuguese label (e.g. 'Futebol e esportes'), using the same canonical
 * list the select is built from. Returns null for an empty/unknown value —
 * callers must treat that exactly like "no theme selected" (never invent a
 * theme for an unrecognized value).
 */
export function resolveWritingThemeLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return WRITING_THEMES.find((t) => t.value === value)?.label ?? null;
}
