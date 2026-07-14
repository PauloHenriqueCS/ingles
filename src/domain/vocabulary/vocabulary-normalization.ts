import type { VocabularyItemKind } from './vocabulary-types';

// Common English contractions to expand
const CONTRACTIONS: Record<string, string> = {
  "i'm": "i am",
  "i've": "i have",
  "i'll": "i will",
  "i'd": "i would",
  "don't": "do not",
  "doesn't": "does not",
  "didn't": "did not",
  "can't": "cannot",
  "won't": "will not",
  "isn't": "is not",
  "aren't": "are not",
  "wasn't": "was not",
  "weren't": "were not",
  "it's": "it is",
  "that's": "that is",
  "there's": "there is",
  "they're": "they are",
  "we're": "we are",
  "you're": "you are",
  "he's": "he is",
  "she's": "she is",
  "they've": "they have",
  "we've": "we have",
  "you've": "you have",
  "they'll": "they will",
  "we'll": "we will",
  "you'll": "you will",
};

// British to American spelling map
const BRITISH_TO_AMERICAN: Record<string, string> = {
  "colour": "color",
  "favour": "favor",
  "honour": "honor",
  "behaviour": "behavior",
  "centre": "center",
  "defence": "defense",
  "organisation": "organization",
  "realise": "realize",
  "analyse": "analyze",
  "travelling": "traveling",
  "modelling": "modeling",
  "jewellery": "jewelry",
  "fulfil": "fulfill",
  "skilful": "skillful",
};

// Common phrasal verb particles
const PHRASAL_VERB_PARTICLES = new Set([
  'up', 'down', 'out', 'in', 'on', 'off', 'away', 'back', 'through', 'around',
  'over', 'under', 'about', 'along', 'apart', 'forward', 'into', 'onto', 'across',
]);

// Common connectors
const CONNECTORS = new Set([
  'although', 'however', 'therefore', 'moreover', 'furthermore', 'nevertheless',
  'nonetheless', 'consequently', 'meanwhile', 'otherwise', 'besides', 'accordingly',
  'subsequently', 'thus', 'hence', 'whereas', 'whereby', 'thereby', 'meanwhile',
  'additionally', 'alternatively', 'conversely', 'similarly', 'likewise',
]);

// Basic normalisation: lowercase, trim, collapse whitespace
export function normalizeVocabularyValue(value: string): string {
  // 1. Trim and collapse whitespace
  let result = value.trim().replace(/\s+/g, ' ');
  // 2. Lowercase
  result = result.toLowerCase();
  // 3. Remove leading/trailing punctuation (but keep hyphens within words)
  result = result.replace(/^[^\w\s-]+/, '').replace(/[^\w\s-]+$/, '');
  return result;
}

// Structural normalization: expand contractions, remove punctuation, normalize spaces
export function normalizeForStructuralComparison(value: string): string {
  // 1. normalizeVocabularyValue
  let result = normalizeVocabularyValue(value);
  // 2. Expand contractions (use CONTRACTIONS map)
  const words = result.split(' ');
  const expanded = words.map(w => CONTRACTIONS[w] ?? w);
  result = expanded.join(' ');
  // 3. Remove all punctuation except hyphens in compound words
  //    Keep hyphen only when between word characters
  result = result.replace(/(?<!\w)-(?!\w)/g, ' ').replace(/[^\w\s-]/g, '');
  // 4. Normalize British spelling to American
  const tokens = result.split(' ');
  const americanized = tokens.map(w => BRITISH_TO_AMERICAN[w] ?? w);
  result = americanized.join(' ');
  // 5. Collapse multiple spaces
  result = result.replace(/\s+/g, ' ').trim();
  return result;
}

// Resolve lemma of a word (simple rule-based, not full NLP)
export function resolveLemma(word: string): string {
  const w = normalizeVocabularyValue(word);
  // Only apply to single words
  if (w.includes(' ') || w.includes('-')) return w;

  // Remove trailing 'ing' for gerunds (drop 'ing', check for doubled consonant)
  if (w.length > 5 && w.endsWith('ing')) {
    const stem = w.slice(0, -3);
    // doubled consonant: running → run
    if (stem.length >= 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
      return stem.slice(0, -1);
    }
    // e-drop: making → make
    if (stem.length >= 2) {
      const withE = stem + 'e';
      // heuristic: if stem ends in consonant preceded by vowel, restore e
      const vowels = 'aeiou';
      const lastChar = stem[stem.length - 1];
      const secondLast = stem[stem.length - 2];
      if (!vowels.includes(lastChar) && vowels.includes(secondLast)) {
        return withE;
      }
    }
    return stem;
  }

  // Remove trailing 'ed' for past tense (regular -ed verbs)
  if (w.length > 4 && w.endsWith('ed')) {
    const stem = w.slice(0, -2);
    // doubled consonant: stopped → stop
    if (stem.length >= 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
      return stem.slice(0, -1);
    }
    // e-drop: hoped → hope
    const vowels = 'aeiou';
    const lastChar = stem[stem.length - 1];
    const secondLast = stem.length >= 2 ? stem[stem.length - 2] : '';
    if (!vowels.includes(lastChar) && vowels.includes(secondLast)) {
      return stem + 'e';
    }
    return stem;
  }

  // Remove trailing 'es' for third-person singular / plural (e.g., goes → go, goes, fixes)
  if (w.length > 3 && w.endsWith('es')) {
    const stem = w.slice(0, -2);
    if (stem.length >= 2) return stem;
  }

  // Remove trailing 's' for plural nouns (basic check)
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) {
    return w.slice(0, -1);
  }

  return w;
}

// Normalize for deduplication — most aggressive normalization
export function normalizeForDeduplication(value: string): string {
  const structural = normalizeForStructuralComparison(value);
  const tokens = structural.split(' ');
  if (tokens.length === 1) {
    // Single word: lemmatize
    return resolveLemma(tokens[0]);
  }
  // Multiword: preserve order (phrasal verbs have fixed order), lemmatize each token
  return tokens.map(t => resolveLemma(t)).join(' ');
}

// Detect if a value is a multiword expression
export function isMultiwordExpression(value: string): boolean {
  const normalized = normalizeVocabularyValue(value);
  // Contains space → definitely multiword
  if (normalized.includes(' ')) return true;
  // Contains hyphen between word characters and has 2+ word segments
  const hyphenParts = normalized.split('-').filter(p => p.length > 0);
  if (hyphenParts.length >= 3) return true; // e.g., well-thought-out
  return false;
}

// Resolve which vocabulary kind a value is (heuristic)
export function inferVocabularyKind(value: string): VocabularyItemKind {
  const normalized = normalizeVocabularyValue(value);
  const tokens = normalized.split(' ');

  // Connector: single word that is a known connector
  if (tokens.length === 1 && CONNECTORS.has(normalized)) {
    return 'connector';
  }

  // Single word: default to 'word'
  if (tokens.length === 1 && !normalized.includes('-')) {
    return 'word';
  }

  // Phrasal verb: 2 tokens where first looks like a verb and second is a particle
  if (tokens.length === 2) {
    const particle = tokens[1];
    if (PHRASAL_VERB_PARTICLES.has(particle)) {
      return 'phrasal_verb';
    }
    // 2-3 token collocation: verb + noun or adj + noun
    return 'collocation';
  }

  if (tokens.length === 3) {
    // Could be collocation or fixed_expression
    return 'collocation';
  }

  // 4+ tokens
  if (tokens.length >= 4) {
    return 'fixed_expression';
  }

  // Hyphenated single word (e.g., self-confidence)
  if (normalized.includes('-')) {
    return 'word';
  }

  // Fallback
  return 'fixed_expression';
}
