/**
 * Conversation LANGUAGE MODE — the student's choice of how to talk before a
 * session. GENERALIZED: the values never encode a specific language pair.
 *   - 'target_only'       — fully in the target (learned) language.
 *   - 'bilingual_support' — the base (interface) language may be used to explain
 *                           while the student still produces the target language.
 *
 * Enum-only: the frontend passes ONLY the mode to the server, which owns all
 * pedagogical prose via data-driven templates (see api/conversation and
 * prompt_templates). The recommendation-by-level below is a soft UI hint (which
 * option is badged) — it never blocks; any level can pick either.
 *
 * The USER-FACING copy stays product copy ("Inglês" / "Português + Inglês") and
 * lives in the i18n table — this module is the internal, generalized identity.
 */

export type ConversationLanguageMode = 'target_only' | 'bilingual_support';

export const CONVERSATION_LANGUAGE_MODES: readonly ConversationLanguageMode[] = [
  'target_only',
  'bilingual_support',
];

/** Historical/default behavior when nothing was chosen or stored. */
export const DEFAULT_CONVERSATION_LANGUAGE_MODE: ConversationLanguageMode = 'target_only';

export function isConversationLanguageMode(value: unknown): value is ConversationLanguageMode {
  return value === 'target_only' || value === 'bilingual_support';
}

/**
 * Normalize any accepted value (generalized OR legacy) to a generalized mode, or
 * null if unrecognized. Legacy compatibility (temporary) for values persisted
 * before the generalization: 'english_only' → 'target_only', 'bilingual_pt_en' →
 * 'bilingual_support'.
 */
export function normalizeConversationLanguageMode(value: unknown): ConversationLanguageMode | null {
  if (value === 'target_only' || value === 'bilingual_support') return value;
  if (value === 'english_only') return 'target_only';
  if (value === 'bilingual_pt_en') return 'bilingual_support';
  return null;
}

/**
 * Which mode is RECOMMENDED (badged) for a given CEFR level. Beginners (A1/A2)
 * benefit from base-language scaffolding, so bilingual is recommended; from B1
 * upward target-only is recommended. This is only the default/badge — the user
 * can always override. An unknown/absent level is treated conservatively as
 * non-beginner (target_only recommended), matching the historical default.
 */
export function recommendConversationLanguageMode(levelCode: string | null | undefined): ConversationLanguageMode {
  const code = (levelCode ?? '').trim().toUpperCase();
  return code === 'A1' || code === 'A2' ? 'bilingual_support' : 'target_only';
}
