/**
 * Pure text normalization utilities for rewrite comparison.
 * No external dependencies.
 */

/** Trim, collapse whitespace to single space, lowercase. */
export function normalizeTextForExactComparison(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

const CONTRACTIONS: ReadonlyArray<[RegExp, string]> = [
  [/\bit's\b/g, 'it is'],
  [/\bi'm\b/g, 'i am'],
  [/\bi've\b/g, 'i have'],
  [/\bdon't\b/g, 'do not'],
  [/\bcan't\b/g, 'cannot'],
  [/\bwon't\b/g, 'will not'],
  [/\bi'll\b/g, 'i will'],
  [/\bthey're\b/g, 'they are'],
  [/\bwe're\b/g, 'we are'],
  [/\byou're\b/g, 'you are'],
  [/\bthat's\b/g, 'that is'],
  [/\bthere's\b/g, 'there is'],
  [/\bit'll\b/g, 'it will'],
  [/\bi'd\b/g, 'i would'],
  [/\bhe's\b/g, 'he is'],
  [/\bshe's\b/g, 'she is'],
];

/**
 * Ignores cosmetic differences: applies exact normalization,
 * removes most punctuation, and expands common contractions.
 */
export function normalizeTextForStructuralComparison(text: string): string {
  let result = normalizeTextForExactComparison(text);

  // Expand contractions (after lowercasing)
  for (const [pattern, replacement] of CONTRACTIONS) {
    result = result.replace(pattern, replacement);
  }

  // Remove most punctuation (keep spaces and alphanumerics)
  result = result.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

  return result;
}

/**
 * Broadest normalization for copy detection:
 * applies structural normalization, removes remaining punctuation/underscores,
 * then sorts words within each sentence.
 */
export function normalizeTextForCopyDetection(text: string): string {
  const structural = normalizeTextForStructuralComparison(text);

  // Remove underscores and any remaining non-alphanumeric-space characters
  const cleaned = structural.replace(/[_]/g, ' ').replace(/\s+/g, ' ').trim();

  // Split into pseudo-sentences on common sentence boundaries (already lowercased)
  const sentences = cleaned.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);

  // Sort words within each sentence for order-agnostic comparison
  const sortedSentences = sentences.map(sentence => {
    const words = sentence.split(/\s+/).filter(Boolean);
    words.sort();
    return words.join(' ');
  });

  return sortedSentences.join(' ');
}

/**
 * Deterministic djb2 hash — pure TypeScript, no Node crypto.
 * Returns hex string.
 */
function djb2(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash; // convert to 32-bit int
  }
  return (hash >>> 0).toString(16);
}

/** Deterministic hash: same input → same output. Uses djb2 on exact-normalized text. */
export function hashText(text: string): string {
  return djb2(normalizeTextForExactComparison(text));
}
