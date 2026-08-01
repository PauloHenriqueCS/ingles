/**
 * Single definition of how a recurring mistake maps to a grammar-review topic
 * label (the chips shown on Revisão → Gramática). Used both to EXTRACT the
 * topic list from a learner's mistakes and to find the contextual mistake that
 * caused a given topic — so the "recomendado porque você escreveu X em vez de
 * Y" explanation reuses persisted data with no AI call and no duplicated regex.
 */

export interface MistakeLike {
  original?: string;
  correct?: string;
  explanation?: string;
}

export interface GrammarFocusTopicRule {
  /** Display label shown on the chip. */
  label: string;
  /** Matches against a mistake's combined text (explanation + original + correct). */
  pattern: RegExp;
}

// Order matters: it defines the order topics first appear in the chip list.
export const GRAMMAR_FOCUS_TOPIC_RULES: readonly GrammarFocusTopicRule[] = [
  { label: 'Simple Past', pattern: /passado|past tense|simple past|went|yesterday|was |were / },
  { label: 'Prepositions', pattern: /preposição|preposition|in\/on|on the|in the|at the/ },
  { label: 'Articles', pattern: /artigo|article|\ba\/an\b|use the|use a\b/ },
  { label: 'Word Order', pattern: /word order|ordem das palavras/ },
  { label: 'Plural', pattern: /plural|plurais/ },
  { label: 'Sentence Structure', pattern: /sentence structure|estrutura da frase/ },
  { label: 'Present Continuous', pattern: /continuous|is doing|is going|estar fazendo/ },
  { label: 'Future', pattern: /\bwill\b|future|futuro/ },
  { label: 'Comparatives', pattern: /comparativ|more.*than|er than/ },
];

function mistakeText(m: MistakeLike): string {
  return `${m.explanation ?? ''} ${m.original ?? ''} ${m.correct ?? ''}`.toLowerCase();
}

/** All topic labels a set of mistakes touches, in rule order, de-duplicated. */
export function extractGrammarFocusLabels(mistakes: readonly MistakeLike[]): string[] {
  const topics = new Set<string>();
  for (const m of mistakes) {
    const text = mistakeText(m);
    for (const rule of GRAMMAR_FOCUS_TOPIC_RULES) {
      if (rule.pattern.test(text)) topics.add(rule.label);
    }
  }
  return Array.from(topics);
}

/**
 * The first mistake that produced a given topic label — used to show the
 * learner the concrete error behind the recommendation. Returns null when no
 * persisted mistake matches (then the UI shows only the general explanation).
 */
export function findMistakeForTopic<T extends MistakeLike>(
  label: string,
  mistakes: readonly T[],
): T | null {
  const rule = GRAMMAR_FOCUS_TOPIC_RULES.find((r) => r.label === label);
  if (!rule) return null;
  for (const m of mistakes) {
    if (rule.pattern.test(mistakeText(m))) return m;
  }
  return null;
}
