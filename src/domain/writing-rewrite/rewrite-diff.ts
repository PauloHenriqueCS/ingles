/**
 * Word-level diff and sentence alignment.
 * Pure TypeScript — no external dependencies.
 * Uses LCS (Longest Common Subsequence) for word-level diff.
 */

export type DiffOperation = 'equal' | 'insert' | 'delete' | 'replace';

export interface WordDiffToken {
  op: DiffOperation;
  value: string;
  originalIndex?: number;
  rewriteIndex?: number;
}

/** Split text into word tokens, normalizing punctuation away for comparison. */
export function tokenizeIntoWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map(w => w.replace(/[^\w]/g, ''))
    .filter(w => w.length > 0);
}

/** Compute LCS length table for two word arrays. */
function buildLCSTable(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  return dp;
}

/** Backtrack the LCS table to produce diff tokens. */
function backtrackLCS(
  dp: number[][],
  a: string[],
  b: string[],
  i: number,
  j: number,
  tokens: WordDiffToken[],
): void {
  if (i === 0 && j === 0) return;

  if (i === 0) {
    // Only insertions remain
    backtrackLCS(dp, a, b, i, j - 1, tokens);
    tokens.push({ op: 'insert', value: b[j - 1], rewriteIndex: j - 1 });
  } else if (j === 0) {
    // Only deletions remain
    backtrackLCS(dp, a, b, i - 1, j, tokens);
    tokens.push({ op: 'delete', value: a[i - 1], originalIndex: i - 1 });
  } else if (a[i - 1] === b[j - 1]) {
    backtrackLCS(dp, a, b, i - 1, j - 1, tokens);
    tokens.push({ op: 'equal', value: a[i - 1], originalIndex: i - 1, rewriteIndex: j - 1 });
  } else if (dp[i - 1][j] >= dp[i][j - 1]) {
    backtrackLCS(dp, a, b, i - 1, j, tokens);
    tokens.push({ op: 'delete', value: a[i - 1], originalIndex: i - 1 });
  } else {
    backtrackLCS(dp, a, b, i, j - 1, tokens);
    tokens.push({ op: 'insert', value: b[j - 1], rewriteIndex: j - 1 });
  }
}

/**
 * Simple LCS-based word diff.
 * Returns array of tokens with op: 'equal' | 'insert' | 'delete'.
 * Adjacent delete+insert pairs may represent 'replace' semantically,
 * but are emitted as separate tokens for simplicity.
 */
export function computeWordDiff(original: string, rewrite: string): WordDiffToken[] {
  const aWords = tokenizeIntoWords(original);
  const bWords = tokenizeIntoWords(rewrite);

  if (aWords.length === 0 && bWords.length === 0) return [];

  const dp = buildLCSTable(aWords, bWords);
  const tokens: WordDiffToken[] = [];
  backtrackLCS(dp, aWords, bWords, aWords.length, bWords.length, tokens);

  return tokens;
}

/** Split text into sentences on common sentence boundaries. */
export function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])[\s\n]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

export interface SentenceAlignment {
  originalSentence: string;
  rewriteSentence: string | null; // null if deleted/not found
  similarity: number; // 0–1 Jaccard similarity
}

/** Word overlap similarity using Jaccard index (0–1). */
export function wordOverlapSimilarity(a: string, b: string): number {
  const aWords = new Set(tokenizeIntoWords(a));
  const bWords = new Set(tokenizeIntoWords(b));

  if (aWords.size === 0 && bWords.size === 0) return 1;
  if (aWords.size === 0 || bWords.size === 0) return 0;

  let intersectionSize = 0;
  for (const word of aWords) {
    if (bWords.has(word)) intersectionSize++;
  }

  const unionSize = aWords.size + bWords.size - intersectionSize;
  return intersectionSize / unionSize;
}

/**
 * Align original sentences to rewrite sentences using word overlap (Jaccard similarity).
 * For each original sentence, finds the best matching rewrite sentence.
 */
export function alignSentences(
  originalSentences: string[],
  rewriteSentences: string[],
): SentenceAlignment[] {
  return originalSentences.map(origSentence => {
    if (rewriteSentences.length === 0) {
      return { originalSentence: origSentence, rewriteSentence: null, similarity: 0 };
    }

    let bestSentence: string | null = null;
    let bestSimilarity = -1;

    for (const rewSentence of rewriteSentences) {
      const sim = wordOverlapSimilarity(origSentence, rewSentence);
      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        bestSentence = rewSentence;
      }
    }

    return {
      originalSentence: origSentence,
      rewriteSentence: bestSimilarity > 0 ? bestSentence : null,
      similarity: Math.max(0, bestSimilarity),
    };
  });
}
