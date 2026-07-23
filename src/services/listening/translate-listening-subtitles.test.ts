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
  SubtitleTranslationParseError,
  SubtitleTranslationOutputTruncatedError,
  BATCH_TRANSLATION_MAX_TOKENS,
  BATCH_TRANSLATION_TIMEOUT_MS,
  MAX_BATCH_SUBDIVISION_DEPTH,
  MAX_BATCH_TRANSLATION_CALLS_PER_BATCH,
  translateCueRangeWithAdaptiveSubdivision,
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

  it('does NOT pass maxTokens/timeoutMs — the block-2-batch-2 hang fix is scoped to batch translation only, not the validator', async () => {
    const callAI = makeQualityAI([JSON.stringify({
      schemaVersion: '2.0',
      cues: [{ cueKey: 'b1-c001', valid: true, issues: [] }],
    })]);
    await validateBlockTranslationWithAI(1, 'The fox ran fast.', cues, 'A1', 'ep1', callAI);

    const call = (callAI as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[2]).toBeUndefined();
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

  it('does NOT pass maxTokens/timeoutMs — the block-2-batch-2 hang fix is scoped to batch translation only, not correction', async () => {
    const cues = [makeValidatedCue('b1-c001', 'The fox ran fast.', 'A raposa correu rápido.')];
    const validation: SubtitleQualityValidationResult = {
      schemaVersion: '2.0', overallValid: false,
      cueResults: [{ cueKey: 'b1-c001', valid: false, issues: ['Loses the emphasis on speed.'] }],
    };
    const callAI = vi.fn(async () => ({
      text: JSON.stringify({ 'b1-c001': 'A raposa correu MUITO rápido.' }), usage: makeUsage(), requestId: null,
    }));

    await correctBlockTranslation(1, 'Full block text.', cues, validation, 'A1', 'ep1', callAI);

    const call = (callAI as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[2]).toEqual({ temperature: 0.2, jsonMode: true });
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

  it('throws if a correction still leaves a complete English sentence translated as an unfinished one', () => {
    const cues = [makeValidatedCue(
      'b1-c001',
      '"This can be my new home," she says to herself.',
      '"Este pode ser meu novo", ela diz para si mesma',
    )];
    expect(() => reassertCorrectedCuesDeterministically(1, cues))
      .toThrow(SubtitleTranslationValidationError);
  });

  it('throws if a correction turns an English question into a pt-BR statement', () => {
    const cues = [makeValidatedCue('b1-c001', 'How can I help you?', 'Como posso ajudar você.')];
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

  it('passes low temperature, JSON mode, a bounded max_tokens, and a 45s timeout on every translation call', async () => {
    const block1 = makeBlockCueData(1, 1);
    const block2 = makeBlockCueData(2, 1);
    const callAI = makeBatchAI([{ 'b1-c001': 'x' }, { 'b2-c001': 'y' }]);

    await translateSubtitles([block1, block2], 'ep1', 'Title', null, 'A1', callAI);

    for (const call of (callAI as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[2]).toMatchObject({
        temperature: 0.2,
        jsonMode: true,
        maxTokens: BATCH_TRANSLATION_MAX_TOKENS,
        timeoutMs: BATCH_TRANSLATION_TIMEOUT_MS,
      });
      expect(typeof call[2].idempotencyKey).toBe('string');
      expect(call[2].idempotencyKey.length).toBeGreaterThan(0);
    }
  });

  it('BATCH_TRANSLATION_MAX_TOKENS/BATCH_TRANSLATION_TIMEOUT_MS have the values found live to fix the block-2-batch-2 hang (1800 tokens, 45s)', () => {
    // Pins the exact constants so a future edit can't silently drift them
    // back toward "no cap" / the shared 120s timeout without a deliberate
    // change to this test.
    expect(BATCH_TRANSLATION_MAX_TOKENS).toBe(1800);
    expect(BATCH_TRANSLATION_TIMEOUT_MS).toBe(45_000);
  });

  it('the same batch (same episode/block/position/content) produces the same idempotencyKey across independent calls', async () => {
    const block1 = makeBlockCueData(1, 1);
    const block2 = makeBlockCueData(2, 1);

    const callAI1 = makeBatchAI([{ 'b1-c001': 'x' }, { 'b2-c001': 'y' }]);
    await translateSubtitles([block1, block2], 'ep-same', 'Title', null, 'A1', callAI1);
    const key1 = (callAI1 as ReturnType<typeof vi.fn>).mock.calls[0][2].idempotencyKey;

    const callAI2 = makeBatchAI([{ 'b1-c001': 'x' }, { 'b2-c001': 'y' }]);
    await translateSubtitles([block1, block2], 'ep-same', 'Title', null, 'A1', callAI2);
    const key2 = (callAI2 as ReturnType<typeof vi.fn>).mock.calls[0][2].idempotencyKey;

    expect(key1).toBe(key2);
  });

  it('a different batch position (block 1 vs block 2) produces a different idempotencyKey', async () => {
    const block1 = makeBlockCueData(1, 1);
    const block2 = makeBlockCueData(2, 1);
    const callAI = makeBatchAI([{ 'b1-c001': 'x' }, { 'b2-c001': 'y' }]);

    await translateSubtitles([block1, block2], 'ep1', 'Title', null, 'A1', callAI);
    const calls = (callAI as ReturnType<typeof vi.fn>).mock.calls;

    expect(calls[0][2].idempotencyKey).not.toBe(calls[1][2].idempotencyKey);
  });

  it('the same batch position with different cue content produces a different idempotencyKey', async () => {
    const block1 = makeBlockCueData(1, 1);
    const block2 = makeBlockCueData(2, 1, 'Other');
    const callAI = makeBatchAI([{ 'b1-c001': 'x' }, { 'b2-c001': 'y' }]);

    await translateSubtitles([block1, block2], 'ep1', 'Title', null, 'A1', callAI);
    const calls = (callAI as ReturnType<typeof vi.fn>).mock.calls;
    const block1Key = calls[0][2].idempotencyKey;

    // Re-run with the same episode/block/position but different source text.
    const block1Changed = makeBlockCueData(1, 1, 'Different');
    const callAI2 = makeBatchAI([{ 'b1-c001': 'x' }, { 'b2-c001': 'y' }]);
    await translateSubtitles([block1Changed, block2], 'ep1', 'Title', null, 'A1', callAI2);
    const block1KeyChanged = (callAI2 as ReturnType<typeof vi.fn>).mock.calls[0][2].idempotencyKey;

    expect(block1Key).not.toBe(block1KeyChanged);
  });

  it('never includes attempt/timestamp/user identity in the idempotencyKey (calling twice does not shift it)', async () => {
    const block1 = makeBlockCueData(1, 1);
    const block2 = makeBlockCueData(2, 1);
    const callAI = makeBatchAI([{ 'b1-c001': 'x' }, { 'b2-c001': 'y' }]);

    await translateSubtitles([block1, block2], 'ep-retry', 'Title', null, 'A1', callAI);
    const firstAttemptKey = (callAI as ReturnType<typeof vi.fn>).mock.calls[0][2].idempotencyKey;

    // Simulate a retry: identical inputs, later wall-clock time.
    await new Promise(resolve => setTimeout(resolve, 5));
    const callAIRetry = makeBatchAI([{ 'b1-c001': 'x' }, { 'b2-c001': 'y' }]);
    await translateSubtitles([block1, block2], 'ep-retry', 'Title', null, 'A1', callAIRetry);
    const retryKey = (callAIRetry as ReturnType<typeof vi.fn>).mock.calls[0][2].idempotencyKey;

    expect(retryKey).toBe(firstAttemptKey);
  });

  it('cut-off mid-object JSON WITHOUT finish_reason=length throws SubtitleTranslationParseError, not SubtitleTranslationOutputTruncatedError — truncation is only ever inferred from finish_reason, never from the shape of the text alone', async () => {
    const block1 = makeBlockCueData(1, 1);
    const block2 = makeBlockCueData(2, 1);
    // No closing brace — LOOKS like a token-limit cutoff, but finishReason
    // is not 'length' (e.g. undefined/'stop'), so it must NOT be classified
    // as truncation.
    const callAI: AICallWithUsageFn = vi.fn(async () => ({
      text: '{"cues": [{"cueKey": "b1-c001", "textPtBr": "ol',
      usage: makeUsage(),
      requestId: null,
      finishReason: 'stop',
    }));

    await expect(
      translateSubtitles([block1, block2], 'ep1', 'Title', null, 'A1', callAI)
    ).rejects.toThrow(SubtitleTranslationParseError);
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

// ── Adaptive subdivision on output truncation ─────────────────────────────────
// Found live (episode 23a7db4d, block 2 batch 2/4, after the max_tokens fix
// landed): the batch that used to hang for 241s instead came back in 17.2s
// with completionTokens===BATCH_TRANSLATION_MAX_TOKENS and
// finish_reason==='length' — proof the model genuinely wants more output for
// this specific batch than any sibling batch. Raising max_tokens further just
// moves the same problem; splitting the batch is the structural fix.

function makeCue(cueKey: string, cueOrder: number, blockOrder: 1 | 2, text: string): EnglishCueDraft {
  return { cueKey, cueOrder, blockOrder, sourceSentenceKeys: [`b${blockOrder}s${String(cueOrder).padStart(2, '0')}`], text };
}

function makeCueRange(blockOrder: 1 | 2, count: number, startAt = 1): EnglishCueDraft[] {
  return Array.from({ length: count }, (_, i) =>
    makeCue(`b${blockOrder}-c${String(startAt + i).padStart(3, '0')}`, startAt + i, blockOrder, `Cue number ${startAt + i}.`));
}

/**
 * Each entry in `script` answers ONE physical call, in order. `truncated:
 * true` returns finish_reason='length' with no usable cues array (matching
 * what a real cut-off completion looks like: text that doesn't parse as
 * complete JSON). Otherwise, responds successfully with a textPtBr for every
 * cueKey the call actually receives (read from the prompt) unless
 * `cueMap` narrows it — letting most tests avoid hand-listing every cueKey.
 */
function makeScriptedAI(script: Array<{ truncated?: boolean; cueMap?: Record<string, string> }>): AICallWithUsageFn {
  let i = 0;
  return vi.fn(async (_system: string, userPrompt: string) => {
    const step = script[i] ?? script[script.length - 1];
    i++;
    if (step.truncated) {
      return {
        text: '{"cues": [{"cueKey": "trunc', // deliberately unparseable — real cutoffs never close their JSON
        usage: makeUsage(),
        requestId: null,
        finishReason: 'length',
      };
    }
    const requestedKeys = [...userPrompt.matchAll(/\[(b\d-c\d+)\]/g)].map(m => m[1]);
    const cueMap = step.cueMap ?? Object.fromEntries(requestedKeys.map(k => [k, `trad-${k}`]));
    return {
      text: JSON.stringify({ cues: Object.entries(cueMap).map(([cueKey, textPtBr]) => ({ cueKey, textPtBr })) }),
      usage: makeUsage(),
      requestId: null,
      finishReason: 'stop',
    };
  });
}

function makeAdaptiveContext(blockOrder: 1 | 2, callAI: AICallWithUsageFn) {
  return {
    episodeId: 'ep1', title: 'Title', synopsis: null, cefrLevel: 'A1' as const,
    blockOrder, blockTextEn: `Full block ${blockOrder} text.`,
    callAI, originalBatchIndex: 0, originalBatchCount: 1,
  };
}

describe('translateSubtitles — adaptive subdivision on output truncation', () => {
  it('1. a normal response needs no subdivision — exactly one call, no truncation', async () => {
    const cues = makeCueRange(1, 5);
    const callAI = makeScriptedAI([{}]);

    const result = await translateCueRangeWithAdaptiveSubdivision(
      cues, undefined, undefined, 0, { remaining: MAX_BATCH_TRANSLATION_CALLS_PER_BATCH },
      makeAdaptiveContext(1, callAI),
    );

    expect(callAI).toHaveBeenCalledTimes(1);
    expect(result.map(c => c.cueKey)).toEqual(['b1-c001', 'b1-c002', 'b1-c003', 'b1-c004', 'b1-c005']);
  });

  it('2. finish_reason=length on a 20-cue batch splits into two successful sub-batches (10+10)', async () => {
    const cues = makeCueRange(1, 20);
    const callAI = makeScriptedAI([
      { truncated: true }, // original 20-cue attempt
      {}, // first half (10 cues) succeeds
      {}, // second half (10 cues) succeeds
    ]);

    const result = await translateCueRangeWithAdaptiveSubdivision(
      cues, undefined, undefined, 0, { remaining: MAX_BATCH_TRANSLATION_CALLS_PER_BATCH },
      makeAdaptiveContext(1, callAI),
    );

    expect(callAI).toHaveBeenCalledTimes(3);
    expect(result).toHaveLength(20);
  });

  it('3. the 10+10 split sends exactly the first 10 and last 10 cueKeys to each half', async () => {
    const cues = makeCueRange(1, 20);
    const callAI = makeScriptedAI([{ truncated: true }, {}, {}]);

    await translateCueRangeWithAdaptiveSubdivision(
      cues, undefined, undefined, 0, { remaining: MAX_BATCH_TRANSLATION_CALLS_PER_BATCH },
      makeAdaptiveContext(1, callAI),
    );

    const calls = (callAI as ReturnType<typeof vi.fn>).mock.calls;
    const firstHalfPrompt = calls[1][1] as string;
    const secondHalfPrompt = calls[2][1] as string;
    expect(firstHalfPrompt).toContain('[b1-c001]');
    expect(firstHalfPrompt).toContain('[b1-c010]');
    expect(firstHalfPrompt).not.toContain('[b1-c011]');
    expect(secondHalfPrompt).toContain('[b1-c011]');
    expect(secondHalfPrompt).toContain('[b1-c020]');
    expect(secondHalfPrompt).not.toContain('[b1-c010]');
  });

  it('4. only one half needs a further split (5+5) after the first split — the already-succeeded half is not re-called', async () => {
    const cues = makeCueRange(1, 20);
    const callAI = makeScriptedAI([
      { truncated: true }, // original 20 cues
      {},                  // first half (10 cues) succeeds immediately
      { truncated: true }, // second half (10 cues) truncates
      {},                  // second half's first sub-half (5 cues) succeeds
      {},                  // second half's second sub-half (5 cues) succeeds
    ]);

    const result = await translateCueRangeWithAdaptiveSubdivision(
      cues, undefined, undefined, 0, { remaining: MAX_BATCH_TRANSLATION_CALLS_PER_BATCH },
      makeAdaptiveContext(1, callAI),
    );

    expect(callAI).toHaveBeenCalledTimes(5);
    expect(result).toHaveLength(20);

    const calls = (callAI as ReturnType<typeof vi.fn>).mock.calls;
    // The first-half call (call index 1) requested exactly cues 1-10 — assert
    // no LATER call ever re-requests that same range (i.e. it was never
    // re-translated after the second half needed extra work).
    const firstHalfPrompt = calls[1][1] as string;
    expect(firstHalfPrompt).toContain('[b1-c001]');
    expect(firstHalfPrompt).toContain('[b1-c010]');
    for (let i = 2; i < calls.length; i++) {
      expect(calls[i][1] as string).not.toContain('[b1-c001]');
    }
  });

  it('5. merge preserves cueKey order across sub-batches', async () => {
    const cues = makeCueRange(1, 20);
    const callAI = makeScriptedAI([{ truncated: true }, {}, {}]);

    const result = await translateCueRangeWithAdaptiveSubdivision(
      cues, undefined, undefined, 0, { remaining: MAX_BATCH_TRANSLATION_CALLS_PER_BATCH },
      makeAdaptiveContext(1, callAI),
    );

    expect(result.map(c => c.cueKey)).toEqual(cues.map(c => c.cueKey));
  });

  it('6. no cue is missing after subdivision', async () => {
    const cues = makeCueRange(1, 20);
    const callAI = makeScriptedAI([{ truncated: true }, {}, {}]);

    const result = await translateCueRangeWithAdaptiveSubdivision(
      cues, undefined, undefined, 0, { remaining: MAX_BATCH_TRANSLATION_CALLS_PER_BATCH },
      makeAdaptiveContext(1, callAI),
    );

    const resultKeys = new Set(result.map(c => c.cueKey));
    for (const c of cues) expect(resultKeys.has(c.cueKey)).toBe(true);
  });

  it('7. no cue is duplicated after subdivision', async () => {
    const cues = makeCueRange(1, 20);
    const callAI = makeScriptedAI([{ truncated: true }, {}, {}]);

    const result = await translateCueRangeWithAdaptiveSubdivision(
      cues, undefined, undefined, 0, { remaining: MAX_BATCH_TRANSLATION_CALLS_PER_BATCH },
      makeAdaptiveContext(1, callAI),
    );

    const keys = result.map(c => c.cueKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('8. an earlier, already-succeeded top-level batch is never re-called when a later batch needs subdivision', async () => {
    // block1: 25 cues -> 2 top-level batches (20 + 5, per TRANSLATION_BATCH_SIZE).
    // Batch 1 (20 cues) succeeds immediately; batch 2 (5 cues) truncates and splits into 3+2.
    const block1 = { blockOrder: 1 as const, blockTextEn: 'Full block 1 text.', cues: makeCueRange(1, 25) };
    const block2 = { blockOrder: 2 as const, blockTextEn: 'Full block 2 text.', cues: makeCueRange(2, 1) };

    const callAI = makeScriptedAI([
      {},                  // batch 1 (cues 1-20) succeeds
      { truncated: true }, // batch 2 (cues 21-25) truncates
      {},                  // batch 2 first half (21-23) succeeds
      {},                  // batch 2 second half (24-25) succeeds
      {},                  // block 2's single cue succeeds
    ]);

    const result = await translateSubtitles([block1, block2], 'ep1', 'Title', null, 'A1', callAI);

    expect(callAI).toHaveBeenCalledTimes(5);
    const block1Result = result.blocks.find(b => b.blockOrder === 1)!;
    expect(block1Result.cues).toHaveLength(25);

    // The first call (batch 1, cues 1-20) must appear exactly once across
    // every call this test made — proof it was never redone when batch 2
    // needed extra work.
    const calls = (callAI as ReturnType<typeof vi.fn>).mock.calls;
    const callsContainingFirstBatch = calls.filter(c => (c[1] as string).includes('[b1-c001]'));
    expect(callsContainingFirstBatch).toHaveLength(1);
  });

  it('9. idempotency keys of sub-batches are stable across independent retries, and differ between the two halves', async () => {
    const cues = makeCueRange(1, 20);

    const callAI1 = makeScriptedAI([{ truncated: true }, {}, {}]);
    await translateCueRangeWithAdaptiveSubdivision(
      cues, undefined, undefined, 0, { remaining: MAX_BATCH_TRANSLATION_CALLS_PER_BATCH },
      makeAdaptiveContext(1, callAI1),
    );
    const keysRun1 = (callAI1 as ReturnType<typeof vi.fn>).mock.calls.map(c => (c[2] as { idempotencyKey: string }).idempotencyKey);

    const callAI2 = makeScriptedAI([{ truncated: true }, {}, {}]);
    await translateCueRangeWithAdaptiveSubdivision(
      cues, undefined, undefined, 0, { remaining: MAX_BATCH_TRANSLATION_CALLS_PER_BATCH },
      makeAdaptiveContext(1, callAI2),
    );
    const keysRun2 = (callAI2 as ReturnType<typeof vi.fn>).mock.calls.map(c => (c[2] as { idempotencyKey: string }).idempotencyKey);

    // Stable across independent runs (same content -> same keys, in the same order).
    expect(keysRun1).toEqual(keysRun2);
    // The two halves (first 10 vs last 10 cues) never share a key.
    expect(keysRun1[1]).not.toBe(keysRun1[2]);
    // The original (pre-split) attempt's key differs from either half's.
    expect(keysRun1[0]).not.toBe(keysRun1[1]);
    expect(keysRun1[0]).not.toBe(keysRun1[2]);
  });

  it('10. exceeding the maximum subdivision depth fails with a clear diagnostic instead of looping', async () => {
    // 40 cues, always truncating: the leftmost recursion path (mid=ceil(n/2)
    // taken as the "first half" each time) reaches depth 5 with 2 cues still
    // remaining — hitting the depth ceiling before the single-cue ceiling.
    // 40 -> 20 -> 10 -> 5 -> 3 -> 2 (depth 5, 2 cues, still truncating).
    const cues = makeCueRange(1, 40);
    const callAI = makeScriptedAI([{ truncated: true }]); // every call truncates

    const rejection = await getRejection(() => translateCueRangeWithAdaptiveSubdivision(
      cues, undefined, undefined, 0, { remaining: 100 },
      makeAdaptiveContext(1, callAI),
    ));

    expect(rejection).toBeInstanceOf(SubtitleTranslationOutputTruncatedError);
    expect((rejection as SubtitleTranslationOutputTruncatedError).reason).toBe('max_depth_exceeded');
  });

  it('11. a single cue that still truncates fails terminally with a clear diagnostic, not another subdivision attempt', async () => {
    const cues = makeCueRange(1, 1);
    const callAI = makeScriptedAI([{ truncated: true }]);

    const rejection = await getRejection(() => translateCueRangeWithAdaptiveSubdivision(
      cues, undefined, undefined, MAX_BATCH_SUBDIVISION_DEPTH - 1, { remaining: MAX_BATCH_TRANSLATION_CALLS_PER_BATCH },
      makeAdaptiveContext(1, callAI),
    ));

    expect(rejection).toBeInstanceOf(SubtitleTranslationOutputTruncatedError);
    expect((rejection as SubtitleTranslationOutputTruncatedError).reason).toBe('single_cue_truncated');
    expect(callAI).toHaveBeenCalledTimes(1); // no further recursion attempted
  });

  it('exceeding the total call budget for one original batch fails with a clear diagnostic', async () => {
    const cues = makeCueRange(1, 20);
    const callAI = makeScriptedAI([{ truncated: true }]); // every call truncates, forcing endless splitting

    const rejection = await getRejection(() => translateCueRangeWithAdaptiveSubdivision(
      cues, undefined, undefined, 0, { remaining: 2 }, // budget exhausted almost immediately
      makeAdaptiveContext(1, callAI),
    ));

    expect(rejection).toBeInstanceOf(SubtitleTranslationOutputTruncatedError);
    expect((rejection as SubtitleTranslationOutputTruncatedError).reason).toBe('max_calls_exceeded');
    // budget=2 allows exactly 2 physical calls (root + first recursive split)
    // before the 3rd attempted call is refused outright.
    expect(callAI).toHaveBeenCalledTimes(2);
  });

  it('12. finish_reason other than "length" (e.g. malformed non-truncated output) is never classified as truncation', async () => {
    const cues = makeCueRange(1, 5);
    const callAI: AICallWithUsageFn = vi.fn(async () => ({
      text: 'this is not JSON at all',
      usage: makeUsage(),
      requestId: null,
      finishReason: 'stop',
    }));

    const rejection = await getRejection(() => translateCueRangeWithAdaptiveSubdivision(
      cues, undefined, undefined, 0, { remaining: MAX_BATCH_TRANSLATION_CALLS_PER_BATCH },
      makeAdaptiveContext(1, callAI),
    ));

    expect(rejection).toBeInstanceOf(SubtitleTranslationParseError);
    expect(rejection).not.toBeInstanceOf(SubtitleTranslationOutputTruncatedError);
    expect(callAI).toHaveBeenCalledTimes(1); // no subdivision attempted for a non-truncation parse failure
  });
});

async function getRejection(fn: () => Promise<unknown>): Promise<unknown> {
  try { await fn(); return null; } catch (e) { return e; }
}
