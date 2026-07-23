import { describe, it, expect, vi } from 'vitest';
import {
  validateTranslationDeterministic,
  findMissingCueKeys,
  mergeRepairedCues,
  translateMissingCues,
  translateSubtitles,
  TRANSLATION_BATCH_SIZE,
  validateBlockTranslationWithAI,
  correctBlockTranslation,
  reassertCorrectedCuesDeterministically,
  SubtitleTranslationValidationError,
  SubtitleQualityValidatorMalformedResponseError,
} from './translate-listening-subtitles';
import type { EnglishCueDraft, RawTranslationResponse, ValidatedTranslatedCue, SubtitleQualityValidationResult } from './listening-subtitle-schema';
import type { AICallWithUsageFn } from './validate-questions-with-ai';

function makeEnCue(cueKey: string, cueOrder: number, blockOrder: 1 | 2, text: string): EnglishCueDraft {
  return { cueKey, cueOrder, blockOrder, sourceSentenceKeys: [`b${blockOrder}s${cueOrder}`], text };
}

function makeEnCuesMap(): Map<1 | 2, EnglishCueDraft[]> {
  return new Map<1 | 2, EnglishCueDraft[]>([
    [1, [
      makeEnCue('b1-c001', 1, 1, 'The fox ran fast.'),
      makeEnCue('b1-c002', 2, 1, 'The dog barked loud.'),
    ]],
    [2, [makeEnCue('b2-c001', 1, 2, 'They went home together.')]],
  ]);
}

function makeUsage() {
  return { promptTokens: 10, completionTokens: 10, totalTokens: 20, durationMs: 10 };
}

// ── Identity-based matching (order independence) ──────────────────────────────

describe('validateTranslationDeterministic — identity-based matching', () => {
  it('accepts cues returned out of order, matching by cueKey rather than array position', () => {
    const raw = {
      schemaVersion: '1.0',
      episodeId: 'ep1',
      blocks: [
        {
          blockOrder: 1,
          // Reversed order relative to englishCuesByBlock
          cues: [
            { cueKey: 'b1-c002', sourceSentenceKeys: ['b1s2'], textPtBr: 'O cachorro latiu alto.' },
            { cueKey: 'b1-c001', sourceSentenceKeys: ['b1s1'], textPtBr: 'A raposa correu rápido.' },
          ],
        },
        { blockOrder: 2, cues: [{ cueKey: 'b2-c001', sourceSentenceKeys: ['b2s1'], textPtBr: 'Eles foram para casa juntos.' }] },
      ],
    };

    const result = validateTranslationDeterministic(raw, makeEnCuesMap());
    // Output must always be in EN canonical order, regardless of the model's order.
    expect(result.get(1)!.map(c => c.cueKey)).toEqual(['b1-c001', 'b1-c002']);
    expect(result.get(1)![0].textPtBr).toBe('A raposa correu rápido.');
    expect(result.get(1)![1].textPtBr).toBe('O cachorro latiu alto.');
  });

  it('throws LISTENING_TRANSLATION_DUPLICATE_CUE when the same cueKey appears twice', () => {
    const raw = {
      schemaVersion: '1.0',
      episodeId: 'ep1',
      blocks: [
        {
          blockOrder: 1,
          cues: [
            { cueKey: 'b1-c001', sourceSentenceKeys: ['b1s1'], textPtBr: 'Texto um.' },
            { cueKey: 'b1-c001', sourceSentenceKeys: ['b1s1'], textPtBr: 'Texto repetido.' },
          ],
        },
        { blockOrder: 2, cues: [{ cueKey: 'b2-c001', sourceSentenceKeys: ['b2s1'], textPtBr: 'Eles foram para casa juntos.' }] },
      ],
    };
    let err: unknown;
    try { validateTranslationDeterministic(raw, makeEnCuesMap()); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SubtitleTranslationValidationError);
    expect((err as SubtitleTranslationValidationError).code).toBe('LISTENING_TRANSLATION_DUPLICATE_CUE');
  });
});

// ── findMissingCueKeys ─────────────────────────────────────────────────────────

describe('findMissingCueKeys', () => {
  it('returns the EN cues whose cueKey has no usable pt-BR entry in the raw response', () => {
    const raw = {
      schemaVersion: '1.0',
      episodeId: 'ep1',
      blocks: [
        { blockOrder: 1, cues: [{ cueKey: 'b1-c001', sourceSentenceKeys: ['b1s1'], textPtBr: 'A raposa correu rápido.' }] }, // b1-c002 missing
        { blockOrder: 2, cues: [{ cueKey: 'b2-c001', sourceSentenceKeys: ['b2s1'], textPtBr: 'Eles foram para casa juntos.' }] },
      ],
    };
    const missing = findMissingCueKeys(raw, makeEnCuesMap());
    expect(missing.get(1)!.map(c => c.cueKey)).toEqual(['b1-c002']);
    expect(missing.has(2)).toBe(false);
  });

  it('treats an empty-string translation as missing, not present', () => {
    const raw = {
      schemaVersion: '1.0',
      episodeId: 'ep1',
      blocks: [
        {
          blockOrder: 1,
          cues: [
            { cueKey: 'b1-c001', sourceSentenceKeys: ['b1s1'], textPtBr: 'A raposa correu rápido.' },
            { cueKey: 'b1-c002', sourceSentenceKeys: ['b1s2'], textPtBr: '   ' },
          ],
        },
        { blockOrder: 2, cues: [{ cueKey: 'b2-c001', sourceSentenceKeys: ['b2s1'], textPtBr: 'Eles foram para casa juntos.' }] },
      ],
    };
    const missing = findMissingCueKeys(raw, makeEnCuesMap());
    expect(missing.get(1)!.map(c => c.cueKey)).toEqual(['b1-c002']);
  });

  it('returns an empty map when every cue is present', () => {
    const raw = {
      schemaVersion: '1.0',
      episodeId: 'ep1',
      blocks: [
        {
          blockOrder: 1,
          cues: [
            { cueKey: 'b1-c001', sourceSentenceKeys: ['b1s1'], textPtBr: 'A raposa correu rápido.' },
            { cueKey: 'b1-c002', sourceSentenceKeys: ['b1s2'], textPtBr: 'O cachorro latiu alto.' },
          ],
        },
        { blockOrder: 2, cues: [{ cueKey: 'b2-c001', sourceSentenceKeys: ['b2s1'], textPtBr: 'Eles foram para casa juntos.' }] },
      ],
    };
    expect(findMissingCueKeys(raw, makeEnCuesMap()).size).toBe(0);
  });
});

// ── mergeRepairedCues ────────────────────────────────────────────────────────

describe('mergeRepairedCues', () => {
  it('merges repaired cues by cueKey without disturbing already-present cues', () => {
    const base: RawTranslationResponse = {
      schemaVersion: '1.0',
      episodeId: 'ep1',
      blocks: [
        { blockOrder: 1, cues: [{ cueKey: 'b1-c001', sourceSentenceKeys: ['b1s1'], textPtBr: 'A raposa correu rápido.' }] },
        { blockOrder: 2, cues: [{ cueKey: 'b2-c001', sourceSentenceKeys: ['b2s1'], textPtBr: 'Eles foram para casa juntos.' }] },
      ],
    };
    const repaired = new Map([
      [1 as const, [{ cueKey: 'b1-c002', sourceSentenceKeys: ['b1s2'], textPtBr: 'O cachorro latiu alto.' }]],
    ]);

    const merged = mergeRepairedCues(base, repaired);
    const block1 = merged.blocks.find(b => b.blockOrder === 1)!;
    expect(block1.cues.map(c => c.cueKey).sort()).toEqual(['b1-c001', 'b1-c002']);
    // Original untouched cue keeps its own translation.
    expect(block1.cues.find(c => c.cueKey === 'b1-c001')!.textPtBr).toBe('A raposa correu rápido.');
    // Block 2 (no repair entry) is unchanged.
    const block2 = merged.blocks.find(b => b.blockOrder === 2)!;
    expect(block2.cues).toHaveLength(1);
  });

  it('overwrites an existing cueKey when the repair provides a corrected version of the same key', () => {
    const base: RawTranslationResponse = {
      schemaVersion: '1.0',
      episodeId: 'ep1',
      blocks: [
        { blockOrder: 1, cues: [{ cueKey: 'b1-c001', sourceSentenceKeys: ['b1s1'], textPtBr: '   ' }] },
        { blockOrder: 2, cues: [] },
      ],
    };
    const repaired = new Map([
      [1 as const, [{ cueKey: 'b1-c001', sourceSentenceKeys: ['b1s1'], textPtBr: 'A raposa correu rápido.' }]],
    ]);
    const merged = mergeRepairedCues(base, repaired);
    const block1 = merged.blocks.find(b => b.blockOrder === 1)!;
    expect(block1.cues).toHaveLength(1);
    expect(block1.cues[0].textPtBr).toBe('A raposa correu rápido.');
  });
});

// ── translateMissingCues ───────────────────────────────────────────────────────

describe('translateMissingCues', () => {
  it('requests and returns translations only for the given missing cues, bucketed by block', async () => {
    const callAI: AICallWithUsageFn = vi.fn(async () => ({
      text: JSON.stringify({
        cues: [
          { cueKey: 'b1-c002', textPtBr: 'O cachorro latiu alto.' },
        ],
      }),
      usage: makeUsage(),
      requestId: null,
    }));

    const missingByBlock = new Map<1 | 2, EnglishCueDraft[]>([
      [1, [makeEnCue('b1-c002', 2, 1, 'The dog barked loud.')]],
    ]);

    const result = await translateMissingCues({
      episodeId: 'ep1',
      title: 'Title',
      synopsis: null,
      cefrLevel: 'A1',
      missingByBlock,
      blockTextEnByOrder: new Map([[1, 'The fox ran fast. The dog barked loud.']]),
      callAI,
    });

    expect(result.get(1)).toEqual([
      { cueKey: 'b1-c002', sourceSentenceKeys: ['b1s2'], textPtBr: 'O cachorro latiu alto.' },
    ]);
  });

  it('ignores cues in the AI response that were not asked for', async () => {
    const callAI: AICallWithUsageFn = vi.fn(async () => ({
      text: JSON.stringify({
        cues: [
          { cueKey: 'b1-c002', textPtBr: 'O cachorro latiu alto.' },
          { cueKey: 'b1-c999', textPtBr: 'Não pedido.' },
        ],
      }),
      usage: makeUsage(),
      requestId: null,
    }));

    const missingByBlock = new Map<1 | 2, EnglishCueDraft[]>([
      [1, [makeEnCue('b1-c002', 2, 1, 'The dog barked loud.')]],
    ]);

    const result = await translateMissingCues({
      episodeId: 'ep1',
      title: 'Title',
      synopsis: null,
      cefrLevel: 'A1',
      missingByBlock,
      blockTextEnByOrder: new Map([[1, 'text']]),
      callAI,
    });

    expect(result.get(1)).toHaveLength(1);
    expect(result.get(1)![0].cueKey).toBe('b1-c002');
  });

  it('the user prompt lists only the missing cue keys, not the full cue set', async () => {
    let capturedPrompt = '';
    const callAI: AICallWithUsageFn = vi.fn(async (_system: string, userPrompt: string) => {
      capturedPrompt = userPrompt;
      return { text: JSON.stringify({ cues: [{ cueKey: 'b1-c002', textPtBr: 'x' }] }), usage: makeUsage(), requestId: null };
    });

    const missingByBlock = new Map<1 | 2, EnglishCueDraft[]>([
      [1, [makeEnCue('b1-c002', 2, 1, 'The dog barked loud.')]],
    ]);

    await translateMissingCues({
      episodeId: 'ep1',
      title: 'Title',
      synopsis: null,
      cefrLevel: 'A1',
      missingByBlock,
      blockTextEnByOrder: new Map([[1, 'The fox ran fast. The dog barked loud.']]),
      callAI,
    });

    expect(capturedPrompt).toContain('b1-c002');
    expect(capturedPrompt).not.toContain('b1-c001');
  });
});

// ── validateBlockTranslationWithAI / correctBlockTranslation (quality layer) ──

function makeValidatedCue(cueKey: string, textEn: string, textPtBr: string): ValidatedTranslatedCue {
  return { cueKey, cueOrder: 1, blockOrder: 1, sourceSentenceKeys: [`b1s${cueKey}`], textEn, textPtBr };
}

function makeQualityAI(responses: string[]): AICallWithUsageFn {
  let i = 0;
  return vi.fn(async () => {
    const text = responses[i] ?? responses[responses.length - 1];
    i++;
    return { text, usage: makeUsage(), requestId: null };
  });
}

describe('validateBlockTranslationWithAI', () => {
  const cues = [makeValidatedCue('b1-c001', 'The fox ran fast.', 'A raposa correu rápido.')];

  it('a semantically correct translation is approved', async () => {
    const callAI = makeQualityAI([JSON.stringify({
      schemaVersion: '2.0',
      cues: [{ cueKey: 'b1-c001', valid: true, issues: [] }],
    })]);
    const result = await validateBlockTranslationWithAI(1, 'The fox ran fast.', cues, 'A1', 'ep1', callAI);
    expect(result.overallValid).toBe(true);
  });

  it('does not reject an acceptable stylistic difference (e.g. natural reordering/synonym) — validator marks it valid', async () => {
    // A stylistically different but equally correct translation; the
    // validator (not this test) is the one judging it — this test asserts
    // that when it says valid:true, the code respects that verdict instead
    // of applying its own extra strictness on top.
    const callAI = makeQualityAI([JSON.stringify({
      schemaVersion: '2.0',
      cues: [{ cueKey: 'b1-c001', valid: true, issues: [] }],
    })]);
    const stylisticCues = [makeValidatedCue('b1-c001', 'The fox ran fast.', 'Rapidamente, a raposa correu.')];
    const result = await validateBlockTranslationWithAI(1, 'The fox ran fast.', stylisticCues, 'A1', 'ep1', callAI);
    expect(result.overallValid).toBe(true);
  });

  it('a translation with a relevant omission is rejected with a specific issue', async () => {
    const callAI = makeQualityAI([JSON.stringify({
      schemaVersion: '2.0',
      cues: [{ cueKey: 'b1-c001', valid: false, issues: ['Omits that the fox ran FAST — pace is lost.'] }],
    })]);
    const result = await validateBlockTranslationWithAI(1, 'The fox ran fast.', cues, 'A1', 'ep1', callAI);
    expect(result.overallValid).toBe(false);
    expect(result.cueResults[0].issues[0]).toContain('Omits');
  });

  it('a translation with invented content is rejected with a specific issue', async () => {
    const callAI = makeQualityAI([JSON.stringify({
      schemaVersion: '2.0',
      cues: [{ cueKey: 'b1-c001', valid: false, issues: ['Adds "no parque" which is not present in the English source.'] }],
    })]);
    const result = await validateBlockTranslationWithAI(1, 'The fox ran fast.', cues, 'A1', 'ep1', callAI);
    expect(result.overallValid).toBe(false);
    expect(result.cueResults[0].issues[0]).toContain('Adds');
  });

  it('retries once on a malformed response and succeeds on the second attempt — never treated as an invalid translation', async () => {
    const callAI = makeQualityAI([
      'not json at all',
      JSON.stringify({ schemaVersion: '2.0', cues: [{ cueKey: 'b1-c001', valid: true, issues: [] }] }),
    ]);
    const result = await validateBlockTranslationWithAI(1, 'The fox ran fast.', cues, 'A1', 'ep1', callAI);
    expect(result.overallValid).toBe(true);
    expect(callAI).toHaveBeenCalledTimes(2);
  });

  it('throws SubtitleQualityValidatorMalformedResponseError (not a false negative) when every attempt is malformed', async () => {
    const callAI = makeQualityAI(['not json', 'still not json']);
    await expect(
      validateBlockTranslationWithAI(1, 'The fox ran fast.', cues, 'A1', 'ep1', callAI)
    ).rejects.toThrow(SubtitleQualityValidatorMalformedResponseError);
    expect(callAI).toHaveBeenCalledTimes(2);
  });

  it('throws the malformed-response error when a requested cueKey has no verdict in the response', async () => {
    const callAI = makeQualityAI([
      JSON.stringify({ schemaVersion: '2.0', cues: [{ cueKey: 'some-other-key', valid: true, issues: [] }] }),
      JSON.stringify({ schemaVersion: '2.0', cues: [{ cueKey: 'some-other-key', valid: true, issues: [] }] }),
    ]);
    await expect(
      validateBlockTranslationWithAI(1, 'The fox ran fast.', cues, 'A1', 'ep1', callAI)
    ).rejects.toThrow(SubtitleQualityValidatorMalformedResponseError);
  });
});

describe('correctBlockTranslation', () => {
  it('sends only the failing cue to correction and preserves the already-valid cue untouched', async () => {
    const cues = [
      makeValidatedCue('b1-c001', 'The fox ran fast.', 'A raposa correu rápido.'),
      makeValidatedCue('b1-c002', 'The dog barked.', 'O cachorro latiu.'),
    ];
    const validation: SubtitleQualityValidationResult = {
      schemaVersion: '2.0',
      overallValid: false,
      cueResults: [
        { cueKey: 'b1-c001', valid: false, issues: ['Loses the emphasis on speed.'] },
        { cueKey: 'b1-c002', valid: true, issues: [] },
      ],
    };
    let capturedPrompt = '';
    const callAI = vi.fn(async (_system: string, userPrompt: string) => {
      capturedPrompt = userPrompt;
      return { text: JSON.stringify({ 'b1-c001': 'A raposa correu MUITO rápido.' }), usage: makeUsage(), requestId: null };
    });

    const result = await correctBlockTranslation(1, 'Full block text.', cues, validation, 'A1', 'ep1', callAI);

    expect(result.find(c => c.cueKey === 'b1-c001')!.textPtBr).toBe('A raposa correu MUITO rápido.');
    expect(result.find(c => c.cueKey === 'b1-c002')!.textPtBr).toBe('O cachorro latiu.'); // unchanged
    expect(capturedPrompt).toContain('Loses the emphasis on speed.');
    expect(capturedPrompt).toContain('b1-c001');
  });

  it('merges the correction back by cueKey — does not reorder or duplicate cues', async () => {
    const cues = [
      makeValidatedCue('b1-c001', 'A.', 'A.'),
      makeValidatedCue('b1-c002', 'B.', 'B ruim.'),
      makeValidatedCue('b1-c003', 'C.', 'C.'),
    ];
    const validation: SubtitleQualityValidationResult = {
      schemaVersion: '2.0', overallValid: false,
      cueResults: [
        { cueKey: 'b1-c001', valid: true, issues: [] },
        { cueKey: 'b1-c002', valid: false, issues: ['wrong'] },
        { cueKey: 'b1-c003', valid: true, issues: [] },
      ],
    };
    const callAI = vi.fn(async () => ({
      text: JSON.stringify({ 'b1-c002': 'B corrigido.' }), usage: makeUsage(), requestId: null,
    }));

    const result = await correctBlockTranslation(1, 'text', cues, validation, 'A1', 'ep1', callAI);
    expect(result.map(c => c.cueKey)).toEqual(['b1-c001', 'b1-c002', 'b1-c003']);
    expect(result.map(c => c.textPtBr)).toEqual(['A.', 'B corrigido.', 'C.']);
  });
});

describe('reassertCorrectedCuesDeterministically', () => {
  it('does not throw for valid corrected cues', () => {
    const cues = [makeValidatedCue('b1-c001', 'She lives at 42 Baker Street.', 'Ela mora na 42 Baker Street.')];
    expect(() => reassertCorrectedCuesDeterministically(1, cues)).not.toThrow();
  });

  it('throws if a correction dropped a number that was present in the English source', () => {
    const cues = [makeValidatedCue('b1-c001', 'She lives at 42 Baker Street.', 'Ela mora na Baker Street.')];
    expect(() => reassertCorrectedCuesDeterministically(1, cues))
      .toThrow(SubtitleTranslationValidationError);
  });

  it('throws if a correction left the cue empty', () => {
    const cues = [makeValidatedCue('b1-c001', 'The fox ran.', '')];
    expect(() => reassertCorrectedCuesDeterministically(1, cues))
      .toThrow(SubtitleTranslationValidationError);
  });
});

// ── translateSubtitles — batching ──────────────────────────────────────────────
// Grounded in real data: buildEnglishSubtitleCues run against a real
// generated A1 block's actual sentences produced 73 cues (see the commit
// this test was added in for the raw numbers). translateSubtitles now
// batches each block's cues into calls of TRANSLATION_BATCH_SIZE (20) so no
// single call has to hold that many cues at once.

function makeBlockCueData(blockOrder: 1 | 2, cueCount: number, textPrefix = 'Sentence'): { blockOrder: 1 | 2; blockTextEn: string; cues: EnglishCueDraft[] } {
  const cues = Array.from({ length: cueCount }, (_, i) =>
    makeEnCue(`b${blockOrder}-c${String(i + 1).padStart(3, '0')}`, i + 1, blockOrder, `${textPrefix} ${i + 1}.`));
  return { blockOrder, blockTextEn: cues.map(c => c.text).join(' '), cues };
}

function makeBatchAI(responsesPerCall: Array<Record<string, string>>): AICallWithUsageFn {
  let i = 0;
  return vi.fn(async () => {
    const cueMap = responsesPerCall[i] ?? responsesPerCall[responsesPerCall.length - 1];
    i++;
    return {
      text: JSON.stringify({ cues: Object.entries(cueMap).map(([cueKey, textPtBr]) => ({ cueKey, textPtBr })) }),
      usage: makeUsage(),
      requestId: null,
    };
  });
}

describe('translateSubtitles — batching', () => {
  it('a block small enough to fit in one batch is translated in a single call', async () => {
    const block1 = makeBlockCueData(1, 3);
    const block2 = makeBlockCueData(2, 2);
    const callAI = makeBatchAI([
      { 'b1-c001': 'um', 'b1-c002': 'dois', 'b1-c003': 'três' },
      { 'b2-c001': 'um', 'b2-c002': 'dois' },
    ]);

    const result = await translateSubtitles([block1, block2], 'ep1', 'Title', null, 'A1', callAI);

    expect(callAI).toHaveBeenCalledTimes(2); // one call per block
    expect(result.blocks.find(b => b.blockOrder === 1)!.cues).toHaveLength(3);
    expect(result.blocks.find(b => b.blockOrder === 2)!.cues).toHaveLength(2);
  });

  it('a block with more cues than TRANSLATION_BATCH_SIZE is split across multiple calls, merged by cueKey', async () => {
    const cueCount = TRANSLATION_BATCH_SIZE * 2 + 5; // forces 3 batches
    const block1 = makeBlockCueData(1, cueCount);
    const block2 = makeBlockCueData(2, 1);

    const responses: Array<Record<string, string>> = [];
    for (let start = 0; start < cueCount; start += TRANSLATION_BATCH_SIZE) {
      const batchMap: Record<string, string> = {};
      for (let i = start; i < Math.min(start + TRANSLATION_BATCH_SIZE, cueCount); i++) {
        batchMap[`b1-c${String(i + 1).padStart(3, '0')}`] = `trad${i + 1}`;
      }
      responses.push(batchMap);
    }
    responses.push({ 'b2-c001': 'trad-b2' });

    const callAI = makeBatchAI(responses);
    const result = await translateSubtitles([block1, block2], 'ep1', 'Title', null, 'A1', callAI);

    // 3 batches for block1 (20+20+5) + 1 call for block2 = 4 calls.
    expect(callAI).toHaveBeenCalledTimes(4);
    const block1Result = result.blocks.find(b => b.blockOrder === 1)!;
    expect(block1Result.cues).toHaveLength(cueCount);
    expect(block1Result.cues.map(c => c.cueKey)).toContain('b1-c001');
    expect(block1Result.cues.map(c => c.cueKey)).toContain(`b1-c${String(cueCount).padStart(3, '0')}`);
  });

  it('passes low temperature and JSON mode on every translation call', async () => {
    const block1 = makeBlockCueData(1, 1);
    const block2 = makeBlockCueData(2, 1);
    const callAI = makeBatchAI([{ 'b1-c001': 'x' }, { 'b2-c001': 'y' }]);

    await translateSubtitles([block1, block2], 'ep1', 'Title', null, 'A1', callAI);

    for (const call of (callAI as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[2]).toEqual({ temperature: 0.2, jsonMode: true });
    }
  });

  it('a cue the batch response omits is simply absent from the block result (feeds the existing missing-cue repair loop, not a hard error here)', async () => {
    const block1 = makeBlockCueData(1, 2);
    const block2 = makeBlockCueData(2, 1);
    const callAI = makeBatchAI([
      { 'b1-c001': 'um' }, // b1-c002 omitted by the model
      { 'b2-c001': 'y' },
    ]);

    const result = await translateSubtitles([block1, block2], 'ep1', 'Title', null, 'A1', callAI);
    const block1Result = result.blocks.find(b => b.blockOrder === 1)!;
    expect(block1Result.cues.map(c => c.cueKey)).toEqual(['b1-c001']);
  });

  it('throws SubtitleTranslationParseError naming the block/batch when a batch response is malformed', async () => {
    const block1 = makeBlockCueData(1, 1);
    const block2 = makeBlockCueData(2, 1);
    const callAI: AICallWithUsageFn = vi.fn(async () => ({ text: 'not json', usage: makeUsage(), requestId: null }));

    await expect(
      translateSubtitles([block1, block2], 'ep1', 'Title', null, 'A1', callAI)
    ).rejects.toThrow(/block 1, batch 1/);
  });
});
