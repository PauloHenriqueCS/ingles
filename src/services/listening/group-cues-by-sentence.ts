import type { EnglishCueDraft } from './listening-subtitle-schema';

/** Anything grouping-by-sentence can operate on — both EnglishCueDraft (pre-translation) and ValidatedTranslatedCue (post-translation, in prepareListeningSubtitles step 9) carry sourceSentenceKeys. */
interface SentenceGroupable {
  sourceSentenceKeys: string[];
}

/**
 * Root cause of cross-cue translation defects seen live across three
 * episodes (a01d96d0, 23a7db4d, b9b43b4a): translation always treated each
 * cue as an independent linguistic unit, even when several cues were really
 * one original sentence split by splitLongSentence, or one cue was really
 * several short sentences merged by buildEnglishSubtitleCues. Asking the
 * model to translate each piece in isolation (with only "context", not an
 * explicit instruction that they must read as ONE coherent whole) is what
 * produced repeated content between adjacent cues, dialogue misattributed
 * to the wrong character, and corrections that never converged — the model
 * was solving the wrong-sized problem.
 *
 * Groups cues that belong to the same original sentence(s) so translation
 * can treat them as one unit. Two adjacent cues are in the same group when
 * their sourceSentenceKeys overlap — covers both directions of the split/
 * merge relationship: a long sentence split into multiple cues (same
 * sentenceKey, multiple cues) and multiple short sentences merged into one
 * cue (one cue, multiple sentenceKeys). Purely sequential (cues are already
 * in stable cueOrder), matching how splits/merges are always locally
 * contiguous in this pipeline — never interleaved.
 */
export function groupCuesBySentence<T extends SentenceGroupable>(cues: T[]): T[][] {
  const groups: T[][] = [];
  let currentKeys = new Set<string>();

  for (const cue of cues) {
    const overlaps = groups.length > 0 && cue.sourceSentenceKeys.some(k => currentKeys.has(k));
    if (overlaps) {
      groups[groups.length - 1].push(cue);
    } else {
      groups.push([cue]);
      currentKeys = new Set<string>();
    }
    for (const k of cue.sourceSentenceKeys) currentKeys.add(k);
  }

  return groups;
}

/**
 * Batches whole sentence groups together, targeting maxCuesPerBatch cues per
 * batch WITHOUT ever splitting a group across two batches — unlike slicing
 * by raw cue count, which could (and did, in principle) cut a multi-cue
 * sentence group across a batch boundary, losing the shared context that
 * makes it translatable as one coherent unit. A single group larger than
 * maxCuesPerBatch becomes its own (oversized) batch rather than being cut.
 */
export function chunkSentenceGroups(groups: EnglishCueDraft[][], maxCuesPerBatch: number): EnglishCueDraft[][][] {
  const batches: EnglishCueDraft[][][] = [];
  let current: EnglishCueDraft[][] = [];
  let currentCueCount = 0;

  for (const group of groups) {
    if (current.length > 0 && currentCueCount + group.length > maxCuesPerBatch) {
      batches.push(current);
      current = [];
      currentCueCount = 0;
    }
    current.push(group);
    currentCueCount += group.length;
  }
  if (current.length > 0) batches.push(current);

  return batches.length > 0 ? batches : [[]];
}

/**
 * Splits a list of sentence groups into two halves at the group boundary
 * closest to the midpoint BY CUE COUNT (not group count), so adaptive
 * subdivision on truncation stays roughly balanced. Never splits inside a
 * group. Only meaningful when groups.length >= 2 — callers must check that
 * first (a single group can never be subdivided without cutting a
 * sentence). On an exact tie between two boundaries (only possible with an
 * odd total split by single-cue groups), the LATER boundary wins, giving a
 * larger first half — matching the plain Math.ceil(n/2) split this replaced,
 * so recursion always explores the same (larger) side first.
 */
export function splitGroupsNearMidpoint(groups: EnglishCueDraft[][]): [EnglishCueDraft[][], EnglishCueDraft[][]] {
  const totalCues = groups.reduce((sum, g) => sum + g.length, 0);
  const targetHalf = totalCues / 2;
  let bestIndex = 1;
  let bestDiff = Infinity;
  let cumulative = 0;
  for (let i = 0; i < groups.length - 1; i++) {
    cumulative += groups[i].length;
    const diff = Math.abs(cumulative - targetHalf);
    if (diff <= bestDiff) {
      bestDiff = diff;
      bestIndex = i + 1;
    }
  }
  return [groups.slice(0, bestIndex), groups.slice(bestIndex)];
}

/** Reconstructs the canonical English (or, from segments, Portuguese) text of a sentence group by joining its cues' text in order — same join rule buildEnglishSubtitleCues/blockTextEn already use elsewhere in this pipeline. */
export function reconstructCanonicalText(pieces: Array<{ text: string }>): string {
  return pieces.map(p => p.text).join(' ');
}

/** Collapses whitespace and trims, so a concatenation-equals-canonical check is not defeated by harmless spacing differences (e.g. a double space where two segments joined). */
export function normalizeForConcatenationCheck(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}
