/**
 * Server-authoritative resolution of a conversation session's LANGUAGE MODE and
 * the composition of its instructions. Small pure functions (mirrors
 * _session-mode.ts) so the rules are unit-tested and reused.
 *
 * The mode is GENERALIZED — it never encodes a specific language pair:
 *   - 'target_only'       — the conversation stays fully in the TARGET (learned)
 *                           language. The base template instructions are used
 *                           UNCHANGED, so existing behavior is preserved.
 *   - 'bilingual_support' — the BASE (interface) language may be used to
 *                           explain/scaffold, while the goal stays producing the
 *                           target language. The pedagogical directive is DATA
 *                           (public.prompt_templates → conversation.bilingual_support),
 *                           composed by the server onto the base instructions —
 *                           NOT hardcoded here.
 *
 * The actual language pair (which language is target, which is base, and their
 * friendly names) is resolved SEPARATELY (see resolveConversationLanguagePair)
 * from the curriculum's language context — the single existing source of truth —
 * so this feature is not tied to Portuguese→English.
 *
 * The mode is resolved at session START and FROZEN onto
 * conversation_session_authorizations.conversation_language_mode (mirrors
 * session_mode). Legacy values ('english_only'/'bilingual_pt_en') and legacy
 * rows are accepted on read and normalized to the generalized values.
 */

export type ConversationLanguageMode = 'target_only' | 'bilingual_support';

/** Safe fallback for clients/rows that never sent a language mode: preserve the
 *  historical behavior (fully in the target language). */
export const DEFAULT_CONVERSATION_LANGUAGE_MODE: ConversationLanguageMode = 'target_only';

export const CONVERSATION_LANGUAGE_MODES: readonly ConversationLanguageMode[] = [
  'target_only',
  'bilingual_support',
];

/** Data-driven template key for the composable bilingual-support directive. */
export const BILINGUAL_SUPPORT_TEMPLATE_KEY = 'conversation.bilingual_support';

/**
 * Normalize any accepted value (generalized OR legacy) to a generalized mode,
 * or null if unrecognized. Legacy compatibility (temporary): 'english_only' →
 * 'target_only', 'bilingual_pt_en' → 'bilingual_support'.
 */
export function normalizeConversationLanguageMode(value: unknown): ConversationLanguageMode | null {
  if (value === 'target_only' || value === 'bilingual_support') return value;
  if (value === 'english_only') return 'target_only';
  if (value === 'bilingual_pt_en') return 'bilingual_support';
  return null;
}

export function isConversationLanguageMode(value: unknown): value is ConversationLanguageMode {
  return value === 'target_only' || value === 'bilingual_support';
}

/**
 * Resolve the language mode from the (optional) client request. Accepts the
 * generalized values and, temporarily, the legacy ones; an unknown/absent value
 * falls back to target_only — the historical behavior — so older clients keep
 * working and a malformed value can never silently enable a different mode.
 */
export function resolveConversationLanguageMode(requested: unknown): ConversationLanguageMode {
  return normalizeConversationLanguageMode(requested) ?? DEFAULT_CONVERSATION_LANGUAGE_MODE;
}

/**
 * The TARGET (language being learned) and BASE (interface/support) languages for
 * a conversation, derived from the curriculum's single language-context source
 * of truth. Isolated here so the target/base mapping lives in ONE place and can
 * be swapped for a richer product-level language source later without touching
 * callers. Today defaults resolve to target=en / base=pt-BR via the curriculum
 * bootstrap default — never hardcoded in this function.
 */
export interface ConversationLanguagePair {
  targetLanguage: string;
  baseLanguage: string;
}

export function resolveConversationLanguagePair(
  languageContext: { learningLanguage: string; interfaceLanguage: string },
): ConversationLanguagePair {
  return {
    targetLanguage: languageContext.learningLanguage,
    baseLanguage: languageContext.interfaceLanguage,
  };
}

/**
 * The language directive that fills the base template's
 * {{conversation_language_directive}} placeholder for TARGET-ONLY mode. It
 * reproduces the strong "speak only in the target language" rule the base
 * template used to hardcode, so existing behavior is preserved — now as a single
 * coherent rule (bilingual mode replaces it with its own directive, so the two
 * never contradict). `style` matches the template's own voice: the guided
 * template is in the target language (English), the free template in the base
 * language (Portuguese); the caller passes the correctly-localized names.
 */
export function buildTargetOnlyDirective(
  style: 'guided' | 'free',
  params: { targetName: string; supportName: string },
): string {
  const { targetName, supportName } = params;
  if (style === 'guided') {
    return [
      `Speak to the learner only in ${targetName}.`,
      `Only brief correction explanations may use ${supportName}.`,
      `Never switch the conversation itself to ${supportName}.`,
    ].join(' ');
  }
  return [
    `- Responda SEMPRE em ${targetName}, mesmo que o aprendiz escreva em outro idioma.`,
    `- Exceção: explicações de correção podem ser em ${supportName}.`,
  ].join('\n');
}
