/**
 * PRODUCT configuration (NOT pedagogical knowledge).
 *
 * The single bootstrap default for the language pair, used only when a user has
 * no explicit curriculum preferences yet. This is product config — the current
 * product ships English taught in Brazilian Portuguese — and is the ONLY place
 * a language literal appears in the engine's edge. It is trivially changeable and
 * carries no grammar/level/curriculum content.
 */
export const CURRICULUM_BOOTSTRAP_DEFAULT = {
  learningLanguage: 'en',
  interfaceLanguage: 'pt-BR',
} as const;
