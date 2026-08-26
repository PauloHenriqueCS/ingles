/**
 * Conversation LANGUAGE MODE — the student's choice of how to talk before a
 * session: fully in the learning language, or bilingual (support language for
 * explanations while still producing the learning language).
 *
 * Data-oriented and enum-only: the frontend passes ONLY the enum to the server,
 * which owns all pedagogical prose (see api/conversation/_language-mode.ts). The
 * recommendation-by-level below is a soft UI hint (which option carries the
 * "Recommended" badge) — it never blocks any choice; any level can pick either.
 */

export type ConversationLanguageMode = 'english_only' | 'bilingual_pt_en';

export const CONVERSATION_LANGUAGE_MODES: readonly ConversationLanguageMode[] = [
  'english_only',
  'bilingual_pt_en',
];

/** Historical/default behavior when nothing was chosen or stored. */
export const DEFAULT_CONVERSATION_LANGUAGE_MODE: ConversationLanguageMode = 'english_only';

export function isConversationLanguageMode(value: unknown): value is ConversationLanguageMode {
  return value === 'english_only' || value === 'bilingual_pt_en';
}

/**
 * Which mode is RECOMMENDED (badged) for a given CEFR level. Beginners (A1/A2)
 * benefit from support-language scaffolding, so bilingual is recommended; from
 * B1 upward English-only is recommended. This is only the default/badge — the
 * user can always override. An unknown/absent level is treated conservatively
 * as non-beginner (english_only recommended), matching the historical default.
 */
export function recommendConversationLanguageMode(levelCode: string | null | undefined): ConversationLanguageMode {
  const code = (levelCode ?? '').trim().toUpperCase();
  return code === 'A1' || code === 'A2' ? 'bilingual_pt_en' : 'english_only';
}
