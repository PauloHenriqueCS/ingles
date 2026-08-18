/**
 * Output-language guard — a dependency-free, language-AGNOSTIC safety net that
 * flags AI output which is evidently in the WRONG language or improperly MIXED,
 * so it is never silently accepted.
 *
 * WHY: the primary fix for the wrong/mixed-language regression is the prompt
 * (naming the target language explicitly). This guard is the secondary net: it
 * detects, deterministically and offline, when generation still drifts — e.g. a
 * story that should be in the learning language but came out in the interface
 * language, or a "corrected" text that mixes the two.
 *
 * MULTILINGUAL BY DESIGN: there is NO "if English"/"if Portuguese" branch. The
 * detector scores the text against a DATA map of high-frequency function words
 * per language code (LANGUAGE_FUNCTION_WORDS). Supporting a new language = add
 * one entry to that map — never a code change. The expected language and every
 * other candidate are treated uniformly.
 *
 * The detector is intentionally CONSERVATIVE (only flags decisive cases) so it
 * never blocks legitimate output: too-short texts are never judged, and a
 * verdict of "wrong/mixed" requires a strong count of another language's
 * function words (which do not occur by accident in correct target-language
 * text).
 */

/**
 * High-frequency FUNCTION words per language code. Function words (articles,
 * pronouns, prepositions, conjunctions, auxiliaries) are chosen because they are
 * near-impossible to avoid when genuinely writing a language and almost never
 * appear from proper nouns or borrowed terms. Codes match the system's
 * learning_language / interface_language codes.
 *
 * Lists favour words that DISCRIMINATE between the languages the product mixes in
 * practice (notably en ↔ pt-BR). They need not be exhaustive — aggregate counts
 * are what matter.
 */
export const LANGUAGE_FUNCTION_WORDS: Record<string, ReadonlySet<string>> = {
  en: new Set([
    'the', 'and', 'is', 'are', 'was', 'were', 'you', 'your', 'they', 'their', 'this',
    'that', 'these', 'those', 'with', 'have', 'has', 'had', 'will', 'would', 'what',
    'when', 'where', 'which', 'because', 'about', 'there', 'here', 'from', 'into',
    "don't", "doesn't", "isn't", "it's", "i'm", 'his', 'her', 'our', 'yours',
  ]),
  'pt-BR': new Set([
    'que', 'não', 'uma', 'com', 'você', 'voce', 'eu', 'ele', 'ela', 'nós', 'nos',
    'para', 'por', 'como', 'mas', 'porque', 'quando', 'onde', 'qual', 'seu', 'sua',
    'meu', 'minha', 'dos', 'das', 'no', 'na', 'ao', 'aos', 'está', 'esta', 'são',
    'sou', 'está', 'muito', 'também', 'sobre', 'isso', 'aqui', 'ali', 'então',
  ]),
  es: new Set([
    'que', 'no', 'una', 'con', 'usted', 'yo', 'él', 'ella', 'nosotros', 'para',
    'por', 'como', 'pero', 'porque', 'cuando', 'donde', 'cuál', 'su', 'mi', 'los',
    'las', 'del', 'está', 'están', 'soy', 'muy', 'también', 'sobre', 'esto', 'aquí',
  ]),
  fr: new Set([
    'le', 'la', 'les', 'des', 'une', 'avec', 'vous', 'nous', 'ils', 'elles', 'pour',
    'par', 'comme', 'mais', 'parce', 'quand', 'où', 'quel', 'son', 'mon', 'est',
    'sont', 'suis', 'très', 'aussi', 'cette', 'ici', 'alors', 'dans', 'pas',
  ]),
  de: new Set([
    'der', 'die', 'das', 'und', 'ist', 'sind', 'war', 'mit', 'sie', 'ihr', 'wir',
    'für', 'weil', 'wenn', 'wo', 'welche', 'sein', 'mein', 'nicht', 'auch', 'sehr',
    'hier', 'dann', 'aber', 'oder', 'ein', 'eine', 'auf', 'dass',
  ]),
  it: new Set([
    'che', 'non', 'una', 'con', 'tu', 'lei', 'noi', 'loro', 'per', 'come', 'ma',
    'perché', 'quando', 'dove', 'quale', 'suo', 'mio', 'sono', 'molto', 'anche',
    'questo', 'qui', 'allora', 'nel', 'della', 'gli', 'sei',
  ]),
};

export interface LanguageGuardOptions {
  /** Candidate language codes to score against. Defaults to all known codes. */
  candidates?: readonly string[];
  /** Below this token count the text is too short to judge → always ok. */
  minTokens?: number;
  /** Minimum other-language function-word hits to call the output wrong/mixed. */
  minForeignHits?: number;
}

export interface LanguageGuardResult {
  ok: boolean;
  expected: string;
  /** The supported language with the most function-word hits, or null. */
  detected: string | null;
  reason?: 'wrong_language' | 'mixed_language';
  scores: Record<string, number>;
}

const DEFAULT_MIN_TOKENS = 12;
const DEFAULT_MIN_FOREIGN_HITS = 3;
// When the expected language IS dominant, a foreign language only counts as
// "mixed" contamination if its hits are a substantial fraction of the expected
// hits. This absorbs the unavoidable function-word overlap between related
// languages (e.g. "que"/"no" shared by pt/es) so a clean text is never flagged.
const MIXED_RATIO = 0.6;

/** Lowercase word tokens, keeping intra-word apostrophes (for "don't", "it's"). */
export function tokenizeWords(text: string): string[] {
  const lowered = (text || '').toLowerCase();
  const matches = lowered.match(/[\p{L}][\p{L}'’]*/gu);
  if (!matches) return [];
  // Normalise the typographic apostrophe so "don't" and "don’t" both match.
  return matches.map((w) => w.replace(/’/g, "'"));
}

/** Count function-word hits for each candidate language. */
export function scoreLanguages(
  tokens: readonly string[],
  candidates: readonly string[],
): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const code of candidates) scores[code] = 0;
  for (const tok of tokens) {
    for (const code of candidates) {
      const set = LANGUAGE_FUNCTION_WORDS[code];
      if (set && set.has(tok)) scores[code] += 1;
    }
  }
  return scores;
}

/**
 * Evaluate whether `text` is plausibly in `expected`. Conservative: returns ok
 * unless another supported language DECISIVELY dominates (wrong_language) or is
 * strongly present alongside the expected one (mixed_language).
 *
 * `expected` with no function-word list (e.g. a language not yet profiled) is
 * never judged — the guard degrades to a no-op rather than risk false positives.
 */
export function evaluateOutputLanguage(
  text: string,
  expected: string,
  options: LanguageGuardOptions = {},
): LanguageGuardResult {
  const candidates = (options.candidates ?? Object.keys(LANGUAGE_FUNCTION_WORDS)).slice();
  if (!candidates.includes(expected)) candidates.push(expected);
  const minTokens = options.minTokens ?? DEFAULT_MIN_TOKENS;
  const minForeignHits = options.minForeignHits ?? DEFAULT_MIN_FOREIGN_HITS;

  const tokens = tokenizeWords(text);
  const scores = scoreLanguages(tokens, candidates);

  // Can't judge: not enough text, or the expected language has no profile.
  if (tokens.length < minTokens || !LANGUAGE_FUNCTION_WORDS[expected]) {
    return { ok: true, expected, detected: null, scores };
  }

  const expectedScore = scores[expected] ?? 0;
  let bestOther: string | null = null;
  let bestOtherScore = 0;
  for (const code of candidates) {
    if (code === expected) continue;
    if ((scores[code] ?? 0) > bestOtherScore) {
      bestOtherScore = scores[code];
      bestOther = code;
    }
  }

  const detected = bestOtherScore > expectedScore ? bestOther : expected;

  // A foreign language is strongly present only when it clears the absolute
  // threshold. Correct target-language text has ~0 foreign function words.
  if (bestOther && bestOtherScore >= minForeignHits) {
    // The other language OUT-scores the expected one → the text is in the wrong
    // language.
    if (bestOtherScore > expectedScore) {
      return { ok: false, expected, detected, reason: 'wrong_language', scores };
    }
    // Expected is dominant but the other language is still substantially present
    // (beyond mere related-language overlap) → the text is mixed.
    if (bestOtherScore >= expectedScore * MIXED_RATIO) {
      return { ok: false, expected, detected, reason: 'mixed_language', scores };
    }
  }

  return { ok: true, expected, detected, scores };
}
