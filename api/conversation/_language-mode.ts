/**
 * Server-authoritative resolution of a conversation session's LANGUAGE MODE and
 * the tutor directive it implies. Kept as small pure functions (mirrors
 * _session-mode.ts) so the rules can be unit-tested and reused, and so the ONE
 * security-relevant guarantee lives in an obvious place: the client sends only
 * an ENUM — never prose — and the actual instruction text is authored here,
 * server-side, and appended to the resolved template instructions.
 *
 * Two modes, orthogonal to Guided/Free:
 *   - 'english_only'   — the conversation stays fully in the learning language.
 *                        The base template instructions are used UNCHANGED, so
 *                        existing English behavior is preserved byte-for-byte.
 *   - 'bilingual_pt_en'— the tutor may use the student's support language to
 *                        explain/scaffold, while the pedagogical goal remains
 *                        producing the learning language. A scoped OVERRIDE
 *                        directive is APPENDED to the base instructions.
 *
 * The mode is resolved at session START and FROZEN onto
 * conversation_session_authorizations.conversation_language_mode, so it stays
 * consistent for the whole session (same guarantee as session_mode). Old rows
 * without the column read back as english_only via DEFAULT_CONVERSATION_LANGUAGE_MODE.
 */

export type ConversationLanguageMode = 'english_only' | 'bilingual_pt_en';

/** Safe fallback for sessions/clients that never sent a language mode (and for
 *  legacy authorization rows whose column is NULL): the historical behavior. */
export const DEFAULT_CONVERSATION_LANGUAGE_MODE: ConversationLanguageMode = 'english_only';

export const CONVERSATION_LANGUAGE_MODES: readonly ConversationLanguageMode[] = [
  'english_only',
  'bilingual_pt_en',
];

export function isConversationLanguageMode(value: unknown): value is ConversationLanguageMode {
  return value === 'english_only' || value === 'bilingual_pt_en';
}

/**
 * Resolve the language mode from the (optional) client request. An unknown /
 * absent value falls back to english_only — the historical behavior — so older
 * clients that send nothing keep working exactly as before, and a malformed
 * value can never silently enable a different mode.
 */
export function resolveConversationLanguageMode(requested: unknown): ConversationLanguageMode {
  return isConversationLanguageMode(requested) ? requested : DEFAULT_CONVERSATION_LANGUAGE_MODE;
}

export interface BilingualDirectiveParams {
  /** Display name of the learning language (e.g. "inglês") — data-driven. */
  targetLabel: string;
  /** Display name of the support/interface language (e.g. "português") — data-driven. */
  supportLabel: string;
  /** CEFR level of the student (e.g. "A1"), used to tune verbosity. */
  cefrLevel: string;
}

/**
 * Builds the bilingual-tutor OVERRIDE directive (authored in the support
 * language). It is written to explicitly AMEND any "always speak the learning
 * language" rule the base template may contain, so there is no ambiguity for
 * the model. Parameterized by the resolved language display names so it is not
 * brittle-hardcoded and generalizes to other support/target pairs later.
 */
export function buildBilingualDirective(params: BilingualDirectiveParams): string {
  const { targetLabel, supportLabel, cefrLevel } = params;
  const isBeginner = /^A[12]$/i.test(cefrLevel.trim());

  const beginnerLine = isBeginner
    ? `- O aluno está em nível inicial (${cefrLevel}): use frases curtas e simples, explicações breves e bastante apoio em ${supportLabel}, sem sobrecarregar.`
    : `- O aluno está em nível ${cefrLevel}: reduza progressivamente a dependência de ${supportLabel} e prefira ${targetLabel} sempre que ele acompanhar.`;

  return [
    `## Modo bilíngue (ATUALIZAÇÃO DA REGRA DE IDIOMA ACIMA — tem prioridade sobre ela)`,
    `Esta é uma sessão de tutoria BILÍNGUE ${supportLabel}–${targetLabel}. Qualquer instrução anterior de "responder sempre em ${targetLabel}" fica AJUSTADA por esta seção. Você é um tutor bilíngue e pode usar ${supportLabel} como idioma de APOIO.`,
    ``,
    `Objetivo pedagógico (inalterado): fazer o aluno PRODUZIR ${targetLabel}. ${supportLabel} é apoio, nunca o idioma predominante da atividade.`,
    ``,
    `Você PODE usar ${supportLabel} para:`,
    `- explicar uma pergunta que o aluno não entendeu;`,
    `- explicar vocabulário, gramática ou uma correção;`,
    `- responder quando o aluno disser que não entendeu;`,
    `- ajudar o aluno a construir uma frase;`,
    `- explicar as instruções da atividade.`,
    ``,
    `Regras:`,
    `- Depois de explicar em ${supportLabel}, sempre reconduza o aluno a responder em ${targetLabel} (ex.: "Agora tente responder em ${targetLabel}: …").`,
    `- Prefira ${targetLabel} durante a prática; use ${supportLabel} apenas quando ajudar de fato. Não responda longamente em ${supportLabel} quando uma explicação curta resolver, e nunca conduza a atividade inteira em ${supportLabel}.`,
    `- Exemplos, frases sugeridas, vocabulário-alvo e as respostas que o aluno deve praticar permanecem em ${targetLabel}.`,
    `- Correções devem mostrar claramente a forma correta em ${targetLabel}; a explicação da correção pode ser em ${supportLabel}.`,
    `- Quando o aluno perguntar "como eu falo X?", forneça a expressão em ${targetLabel} e incentive-o a usá-la.`,
    beginnerLine,
  ].join('\n');
}

/**
 * Returns the final instruction string for the chosen language mode. For
 * english_only the base instructions are returned UNCHANGED (zero behavior
 * change). For bilingual_pt_en the override directive is appended.
 */
export function applyConversationLanguageMode(
  baseInstructions: string,
  mode: ConversationLanguageMode,
  params: BilingualDirectiveParams,
): string {
  if (mode !== 'bilingual_pt_en') return baseInstructions;
  return `${baseInstructions.trimEnd()}\n\n${buildBilingualDirective(params)}`;
}
