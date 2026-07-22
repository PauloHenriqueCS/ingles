import { describe, it, expect, vi } from 'vitest';
import {
  validateTranslationDeterministic,
  findMissingCueKeys,
  mergeRepairedCues,
  translateMissingCues,
  SubtitleTranslationValidationError,
} from './translate-listening-subtitles';
import type { EnglishCueDraft, RawTranslationResponse } from './listening-subtitle-schema';
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
