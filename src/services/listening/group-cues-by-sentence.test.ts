import { describe, it, expect } from 'vitest';
import {
  groupCuesBySentence,
  chunkSentenceGroups,
  splitGroupsNearMidpoint,
  reconstructCanonicalText,
  normalizeForConcatenationCheck,
} from './group-cues-by-sentence';
import type { EnglishCueDraft } from './listening-subtitle-schema';

function cue(cueKey: string, cueOrder: number, sourceSentenceKeys: string[], text: string): EnglishCueDraft {
  return { cueKey, cueOrder, blockOrder: 1, sourceSentenceKeys, text };
}

// Real sentence from episode b9b43b4a-91c6-4e90-8126-e5c545ac9ac9, block 1,
// sentence b1s29 — split by buildEnglishSubtitleCues into cues b1-c034,
// b1-c035, b1-c036 (this is the same sentence used as the worked example in
// build-subtitle-translation-prompt.ts's system prompt). Its final cue
// (b1-c036) is the exact cue that lost its "?" in the live QUESTION_MISMATCH
// failure this whole redesign traces back to.
const DOG_QUESTION_SENTENCE_CUES: EnglishCueDraft[] = [
  cue('b1-c034', 34, ['b1s29'], '"Hello, excuse me,"'),
  cue('b1-c035', 35, ['b1s29'], 'Leo says to a man reading a book,'),
  cue('b1-c036', 36, ['b1s29'], '"Do you know whose dog this is?"'),
];

// Real merge case from the same episode: b1s23 + b1s24 (two short sentences)
// merged into ONE cue (b1-c027) by buildEnglishSubtitleCues.
const MERGED_SENTENCES_CUE: EnglishCueDraft = cue('b1-c027', 27, ['b1s23', 'b1s24'], '"Maybe the owner is in the park." Anna nods.');

describe('groupCuesBySentence', () => {
  it('1. a complete sentence with no split stays its own singleton group', () => {
    const cues = [cue('b1-c001', 1, ['b1s01'], 'Anna walks in the park.')];
    expect(groupCuesBySentence(cues)).toEqual([[cues[0]]]);
  });

  it('2. a sentence split into multiple cues (real b1s29, 3 cues) becomes ONE group', () => {
    const groups = groupCuesBySentence(DOG_QUESTION_SENTENCE_CUES);
    expect(groups).toHaveLength(1);
    expect(groups[0].map(c => c.cueKey)).toEqual(['b1-c034', 'b1-c035', 'b1-c036']);
  });

  it('4. a question split across cues groups together (the trailing "?" cue joins the same group as its lead-in)', () => {
    const groups = groupCuesBySentence(DOG_QUESTION_SENTENCE_CUES);
    expect(groups[0].some(c => c.text.includes('?'))).toBe(true);
    expect(groups).toHaveLength(1); // not 3 independent groups
  });

  it('two consecutive but genuinely different sentences (real b1s16/b1s17, quote spans both stylistically) stay separate groups', () => {
    const cues = [
      cue('b1-c020', 20, ['b1s16'], '"It\'s okay.'),
      cue('b1-c021', 21, ['b1s17'], 'We won\'t hurt you."'),
    ];
    const groups = groupCuesBySentence(cues);
    expect(groups).toHaveLength(2);
  });

  it('multiple short sentences merged into one cue (real b1-c027, b1s23+b1s24) is its own singleton group', () => {
    const groups = groupCuesBySentence([MERGED_SENTENCES_CUE]);
    expect(groups).toEqual([[MERGED_SENTENCES_CUE]]);
  });

  it('a mix of standalone and grouped cues in sequence is partitioned correctly', () => {
    const standalone1 = cue('b1-c033', 33, ['b1s28'], 'Anna nods.');
    const standalone2 = cue('b1-c037', 37, ['b1s30'], 'The man looks at the dog.');
    const cues = [standalone1, ...DOG_QUESTION_SENTENCE_CUES, standalone2];
    const groups = groupCuesBySentence(cues);
    expect(groups).toEqual([[standalone1], DOG_QUESTION_SENTENCE_CUES, [standalone2]]);
  });

  it('never interleaves — group membership is purely sequential/contiguous', () => {
    // Two DIFFERENT sentences that happen to reuse no keys never merge, even
    // if adjacent; only actual sourceSentenceKeys overlap groups cues.
    const a = cue('a1', 1, ['s1'], 'One.');
    const b = cue('a2', 2, ['s2'], 'Two.');
    const c = cue('a3', 3, ['s1'], 'Three.'); // shares s1 with `a`, but is NOT adjacent to it
    expect(groupCuesBySentence([a, b, c])).toEqual([[a], [b], [c]]);
  });
});

describe('reconstructCanonicalText / normalizeForConcatenationCheck', () => {
  it('5. reconstructing the real b1s29 sentence from its 3 cues reproduces the original sentence', () => {
    const reconstructed = reconstructCanonicalText(DOG_QUESTION_SENTENCE_CUES.map(c => ({ text: c.text })));
    expect(reconstructed).toBe('"Hello, excuse me," Leo says to a man reading a book, "Do you know whose dog this is?"');
  });

  it('7. concatenation-equals-canonical check tolerates only whitespace differences, not content differences', () => {
    const canonical = 'Ela pergunta: "Você sabe de quem é este cachorro?"';
    const withExtraSpaces = 'Ela  pergunta: "Você sabe de quem é este cachorro?" ';
    expect(normalizeForConcatenationCheck(canonical)).toBe(normalizeForConcatenationCheck(withExtraSpaces));

    const withDroppedWord = 'Ela: "Você sabe de quem é este cachorro?"';
    expect(normalizeForConcatenationCheck(canonical)).not.toBe(normalizeForConcatenationCheck(withDroppedWord));
  });
});

describe('chunkSentenceGroups — never separates cues of the same sentence', () => {
  it('10. a group that would straddle the batch boundary is kept whole, even if that makes the batch smaller than the target', () => {
    const before = [cue('b1-c032', 32, ['b1s27'], 'A.'), cue('b1-c033', 33, ['b1s28'], 'B.')];
    const groups = groupCuesBySentence([...before, ...DOG_QUESTION_SENTENCE_CUES]);
    // maxCuesPerBatch=4: `before` (2 cues) fits, but the 3-cue group would
    // push the running batch to 5 > 4 — it must start a NEW batch instead
    // of being split.
    const batches = chunkSentenceGroups(groups, 4);
    expect(batches).toHaveLength(2);
    expect(batches[0].flat().map(c => c.cueKey)).toEqual(['b1-c032', 'b1-c033']);
    expect(batches[1].flat().map(c => c.cueKey)).toEqual(['b1-c034', 'b1-c035', 'b1-c036']);
  });

  it('a single group larger than maxCuesPerBatch becomes its own oversized batch rather than being cut', () => {
    const groups = [DOG_QUESTION_SENTENCE_CUES]; // 3 cues, one group
    const batches = chunkSentenceGroups(groups, 2); // smaller than the group itself
    expect(batches).toHaveLength(1);
    expect(batches[0].flat()).toHaveLength(3);
  });

  it('never returns an empty batch list — an empty input yields one empty batch', () => {
    expect(chunkSentenceGroups([], 20)).toEqual([[]]);
  });
});

describe('splitGroupsNearMidpoint', () => {
  it('13. never splits inside a group — only at group boundaries', () => {
    const before = [cue('b1-c032', 32, ['b1s27'], 'A.')];
    const after = [cue('b1-c040', 40, ['b1s31'], 'C.')];
    const groups = groupCuesBySentence([...before, ...DOG_QUESTION_SENTENCE_CUES, ...after]);
    const [first, second] = splitGroupsNearMidpoint(groups);
    // The 3-cue group must land entirely in one half.
    const firstKeys = first.flat().map(c => c.cueKey);
    const secondKeys = second.flat().map(c => c.cueKey);
    const groupKeys = DOG_QUESTION_SENTENCE_CUES.map(c => c.cueKey);
    const allInFirst = groupKeys.every(k => firstKeys.includes(k));
    const allInSecond = groupKeys.every(k => secondKeys.includes(k));
    expect(allInFirst || allInSecond).toBe(true);
  });

  it('balances an even number of singleton groups exactly in half', () => {
    const groups = groupCuesBySentence(Array.from({ length: 10 }, (_, i) => cue(`c${i + 1}`, i + 1, [`s${i + 1}`], 'x')));
    const [first, second] = splitGroupsNearMidpoint(groups);
    expect(first.flat()).toHaveLength(5);
    expect(second.flat()).toHaveLength(5);
  });

  it('an odd number of singleton groups puts the larger half first (matches the old Math.ceil(n/2) split)', () => {
    const groups = groupCuesBySentence(Array.from({ length: 5 }, (_, i) => cue(`c${i + 1}`, i + 1, [`s${i + 1}`], 'x')));
    const [first, second] = splitGroupsNearMidpoint(groups);
    expect(first.flat()).toHaveLength(3);
    expect(second.flat()).toHaveLength(2);
  });
});
