import { segmentListeningText } from './segment-listening-story-text';
import { countWords } from './listening-level-config';

/**
 * Last-resort, zero-AI-cost repair for a block that is still over the word
 * maximum after the AI condense retries in generateBlock1/generateBlock2 are
 * exhausted. Walks the block's sentences in original order (via the same
 * deterministic segmenter used for timing/subtitles) and keeps the longest
 * whole-sentence prefix that fits within [minWords, maxWords].
 *
 * Only ever shortens (never fabricates content), never splits a sentence or
 * word, and preserves order — so it cannot introduce a mid-sentence cut or
 * reorder the narrative. Returns null when no valid prefix exists (e.g. the
 * first sentence alone already exceeds maxWords, or the block is too short
 * once trimmed to fit) so the caller can fall back to failing the job
 * instead of publishing something out of range.
 */
export function condenseBlockDeterministically(
  textEn: string,
  blockOrder: 1 | 2,
  minWords: number,
  maxWords: number,
): string | null {
  let sentences;
  try {
    sentences = segmentListeningText(textEn, blockOrder);
  } catch {
    return null;
  }

  let acc = '';
  let best: string | null = null;

  for (const sentence of sentences) {
    const candidate = acc ? `${acc} ${sentence.textEn}` : sentence.textEn;
    const candidateWords = countWords(candidate);
    if (candidateWords > maxWords) break;
    acc = candidate;
    if (candidateWords >= minWords) best = acc;
  }

  return best;
}
