/**
 * Language context: the pair (learningLanguage, interfaceLanguage) threaded
 * through every generation call. This replaces the implicit "English + pt-BR"
 * assumption that used to be hardcoded across the codebase.
 *
 * The engine itself hardcodes NO language. A single product-level bootstrap
 * default (en/pt-BR) exists only at the composition edge (see callers) and is
 * product configuration, not pedagogical knowledge.
 */

export interface LanguageContext {
  learningLanguage: string;
  interfaceLanguage: string;
}

export interface PartialLanguagePrefs {
  learningLanguage?: string | null;
  interfaceLanguage?: string | null;
}

/**
 * Resolves the effective language context from (possibly partial) user
 * preferences, falling back to an explicitly-provided default. The default MUST
 * be supplied by the caller — the engine never invents 'en'/'pt-BR' on its own.
 */
export function resolveLanguageContext(
  prefs: PartialLanguagePrefs | null | undefined,
  fallback: LanguageContext,
): LanguageContext {
  return {
    learningLanguage: prefs?.learningLanguage?.trim() || fallback.learningLanguage,
    interfaceLanguage: prefs?.interfaceLanguage?.trim() || fallback.interfaceLanguage,
  };
}

export function sameLanguageContext(a: LanguageContext, b: LanguageContext): boolean {
  return a.learningLanguage === b.learningLanguage && a.interfaceLanguage === b.interfaceLanguage;
}
