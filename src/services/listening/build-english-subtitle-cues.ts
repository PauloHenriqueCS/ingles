import type { CEFRLevel } from '../../domain/curriculum/cefr';
import type { EnglishCueDraft } from './listening-subtitle-schema';
import {
  CUE_WORD_COUNT,
  SPLIT_CONJUNCTIONS,
  NO_BREAK_BEFORE,
} from './listening-subtitle-config';

export interface CanonicalSentence {
  sentenceKey: string;
  sentenceOrder: number;
  speaker: string | null;
  textEn: string;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function makeCueKey(blockOrder: 1 | 2, cueOrder: number): string {
  return `b${blockOrder}-c${String(cueOrder).padStart(3, '0')}`;
}

/**
 * Splits a sentence that exceeds maxWords into segments at natural boundaries.
 * Tries (in order): comma positions, conjunction positions, word-count boundary.
 */
function splitLongSentence(text: string, maxWords: number): string[] {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return [text.trim()];

  // 1. Try to split at a comma that falls near the midpoint
  const commaPositions: number[] = [];
  let pos = 0;
  for (let i = 0; i < words.length; i++) {
    pos += words[i].length + (i > 0 ? 1 : 0);
    if (words[i].endsWith(',') && i >= 2 && i < words.length - 2) {
      commaPositions.push(i);
    }
  }
  if (commaPositions.length > 0) {
    // Pick split closest to middle
    const mid = words.length / 2;
    const best = commaPositions.reduce((a, b) =>
      Math.abs(a - mid) <= Math.abs(b - mid) ? a : b
    );
    const first = words.slice(0, best + 1).join(' ');
    const second = words.slice(best + 1).join(' ');
    if (countWords(first) >= 2 && countWords(second) >= 2) {
      const parts: string[] = [];
      for (const part of [first, second]) {
        if (countWords(part) > maxWords) {
          parts.push(...splitLongSentence(part, maxWords));
        } else {
          parts.push(part);
        }
      }
      return parts;
    }
  }

  // 2. Try to split at a conjunction
  const lower = text.toLowerCase();
  for (const conj of SPLIT_CONJUNCTIONS) {
    const idx = lower.indexOf(conj, 4); // skip first few chars
    if (idx > 0 && idx < text.length - conj.length - 4) {
      const first = text.slice(0, idx).trim();
      const second = text.slice(idx + 1).trim(); // keep conjunction with second part
      const fw = countWords(first);
      const sw = countWords(second);
      if (fw >= 2 && sw >= 2) {
        const parts: string[] = [];
        for (const part of [first, second]) {
          if (countWords(part) > maxWords) {
            parts.push(...splitLongSentence(part, maxWords));
          } else {
            parts.push(part);
          }
        }
        return parts;
      }
    }
  }

  // 3. Fall back: split by word count, respecting NO_BREAK_BEFORE
  const splitAt = Math.min(maxWords, Math.ceil(words.length / 2));
  let actualSplit = splitAt;
  // Don't break before a NO_BREAK_BEFORE word
  for (let i = splitAt; i >= 2; i--) {
    if (!NO_BREAK_BEFORE.has(words[i].toLowerCase())) {
      actualSplit = i;
      break;
    }
  }
  const first = words.slice(0, actualSplit).join(' ');
  const second = words.slice(actualSplit).join(' ');
  const parts: string[] = [];
  for (const part of [first, second]) {
    if (countWords(part) > maxWords) {
      parts.push(...splitLongSentence(part, maxWords));
    } else {
      parts.push(part.trim());
    }
  }
  return parts;
}

/**
 * Builds English subtitle cues deterministically from canonical sentences.
 *
 * Rules:
 * - Each sentence becomes at least one cue.
 * - Short consecutive sentences (same speaker, same paragraph) may be merged
 *   if the combined word count stays within the CEFR limit.
 * - Long sentences are split at natural boundaries (comma → conjunction → word boundary).
 * - Different speakers are never merged.
 * - Maximum MAX_SENTENCES_PER_CUE sentences per cue.
 */
export function buildEnglishSubtitleCues(
  sentences: CanonicalSentence[],
  blockOrder: 1 | 2,
  cefrLevel: CEFRLevel,
): EnglishCueDraft[] {
  const { max: maxWords } = CUE_WORD_COUNT[cefrLevel];
  const cues: EnglishCueDraft[] = [];
  let cueOrder = 1;

  // First, expand sentences into atomic units (split long sentences)
  interface Unit {
    sentenceKey: string;
    speaker: string | null;
    text: string;
    isSegment: boolean; // true when split from a longer sentence
  }

  const units: Unit[] = [];
  for (const s of sentences) {
    const segments = splitLongSentence(s.textEn, maxWords);
    if (segments.length === 1) {
      units.push({ sentenceKey: s.sentenceKey, speaker: s.speaker, text: segments[0], isSegment: false });
    } else {
      for (const seg of segments) {
        units.push({ sentenceKey: s.sentenceKey, speaker: s.speaker, text: seg, isSegment: true });
      }
    }
  }

  // Now group units: merge consecutive short units from different sentences (not segments)
  // if same speaker and combined count <= maxWords, and no more than MAX_SENTENCES_PER_CUE
  let i = 0;
  while (i < units.length) {
    const u = units[i];
    const wc = countWords(u.text);

    // Try to merge with the next unit
    const next = i + 1 < units.length ? units[i + 1] : null;
    const canMerge =
      next !== null &&
      !u.isSegment &&
      !next.isSegment &&
      u.sentenceKey !== next.sentenceKey && // different sentences
      u.speaker === next.speaker &&          // same speaker (null == null ok)
      wc + countWords(next.text) <= maxWords;

    if (canMerge && next !== null) {
      const mergedText = `${u.text} ${next.text}`;
      const sourceSentenceKeys = [u.sentenceKey, next.sentenceKey];
      cues.push({
        cueKey: makeCueKey(blockOrder, cueOrder++),
        cueOrder: cueOrder - 1,
        blockOrder,
        sourceSentenceKeys,
        text: mergedText,
      });
      i += 2;
    } else {
      cues.push({
        cueKey: makeCueKey(blockOrder, cueOrder++),
        cueOrder: cueOrder - 1,
        blockOrder,
        sourceSentenceKeys: [u.sentenceKey],
        text: u.text,
      });
      i += 1;
    }
  }

  return cues;
}
