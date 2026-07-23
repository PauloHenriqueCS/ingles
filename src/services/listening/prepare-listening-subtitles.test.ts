import { describe, it, expect, vi } from 'vitest';
import { buildEnglishSubtitleCues } from './build-english-subtitle-cues';
import type { CanonicalSentence } from './build-english-subtitle-cues';
import { validateEnglishReconstruction, normaliseForReconstruction } from './reconstruct-subtitle-text';
import {
  validateTranslationDeterministic,
  SubtitleTranslationParseError,
  SubtitleTranslationValidationError,
} from './translate-listening-subtitles';
import {
  prepareListeningSubtitles,
  ListeningEpisodeNotFoundError,
  ListeningEpisodeNotReadyForSubtitlesError,
  ListeningPublishedEpisodeImmutableError,
  ListeningMissingBlocksError,
  ListeningMissingSentencesError,
  ListeningSubtitlesAlreadyExistError,
  ListeningTranslationCorrectionFailedError,
  ListeningEnglishReconstructionFailedError,
  TRANSLATION_PROMPT_VERSION,
} from './prepare-listening-subtitles';
import type { AICallWithUsageFn } from './prepare-listening-subtitles';
import type { EnglishCueDraft } from './listening-subtitle-schema';

// ─── Constants ────────────────────────────────────────────────────────────────

const EPISODE_ID = 'ep000000-0000-0000-0000-000000000001';
const BLOCK_1_ID = 'bl000000-0000-0000-0000-000000000001';
const BLOCK_2_ID = 'bl000000-0000-0000-0000-000000000002';
const BLOCK_1_TEXT = 'The quick fox sat down.';
const BLOCK_2_TEXT = 'The dog ran home fast.';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeUsage() {
  return { promptTokens: 100, completionTokens: 50, totalTokens: 150, durationMs: 500 };
}

function makeAI(responses: string[]): AICallWithUsageFn {
  let callCount = 0;
  return vi.fn(async () => {
    const text = responses[callCount] ?? responses[responses.length - 1];
    callCount++;
    return { text, usage: makeUsage(), requestId: null };
  });
}

function getError(fn: () => unknown): unknown {
  try { fn(); return null; } catch (e) { return e; }
}

async function getRejection(p: Promise<unknown>): Promise<unknown> {
  try { await p; return null; } catch (e) { return e; }
}

// ─── EnglishCueDraft factories ────────────────────────────────────────────────

function makeEnCue(cueKey: string, cueOrder: number, blockOrder: 1 | 2, text: string): EnglishCueDraft {
  return { cueKey, cueOrder, blockOrder, sourceSentenceKeys: [`b${blockOrder}s01`], text };
}

function makeEnCuesMap(): Map<1 | 2, EnglishCueDraft[]> {
  return new Map<1 | 2, EnglishCueDraft[]>([
    [1, [makeEnCue('b1-c001', 1, 1, BLOCK_1_TEXT)]],
    [2, [makeEnCue('b2-c001', 1, 2, BLOCK_2_TEXT)]],
  ]);
}

// ─── Translation/validator AI response strings ────────────────────────────────

function makeRawTranslation(opts: { block1Cues?: unknown[]; block2Cues?: unknown[] } = {}) {
  return {
    schemaVersion: '1.0',
    episodeId: EPISODE_ID,
    blocks: [
      {
        blockOrder: 1,
        cues: opts.block1Cues ?? [{ cueKey: 'b1-c001', sourceSentenceKeys: ['b1s01'], textPtBr: 'A raposa ágil sentou.' }],
      },
      {
        blockOrder: 2,
        cues: opts.block2Cues ?? [{ cueKey: 'b2-c001', sourceSentenceKeys: ['b2s01'], textPtBr: 'O cachorro correu para casa.' }],
      },
    ],
  };
}

// translateSubtitles now calls once per block (each a "batch"), and each
// call expects/returns the flat {cues:[{cueKey,textPtBr}]} shape (same as
// the missing-cue-repair response) rather than the old single combined
// {schemaVersion,episodeId,blocks:[...]} response. Includes both blocks'
// keys so the same fixture answers whichever block's call is in flight —
// the extra key for the other block is simply ignored by the caller.
function makeTranslationBatchResponse(opts: { block1Cues?: unknown[]; block2Cues?: unknown[] } = {}) {
  return {
    cues: [
      ...(opts.block1Cues ?? [{ cueKey: 'b1-c001', textPtBr: 'A raposa ágil sentou.' }]),
      ...(opts.block2Cues ?? [{ cueKey: 'b2-c001', textPtBr: 'O cachorro correu para casa.' }]),
    ],
  };
}

const TRANSLATION_SUCCESS_JSON = JSON.stringify(makeTranslationBatchResponse());

// Per-cue quality validator schema (v2) — includes both blocks' cue keys so
// the same fixture answers whichever block is currently being validated;
// extra cueKeys beyond what a given call requested are simply ignored.
const VALIDATOR_SUCCESS_JSON = JSON.stringify({
  schemaVersion: '2.0',
  cues: [
    { cueKey: 'b1-c001', valid: true, issues: [] },
    { cueKey: 'b2-c001', valid: true, issues: [] },
  ],
});

const VALIDATOR_FAIL_JSON = JSON.stringify({
  schemaVersion: '2.0',
  cues: [
    { cueKey: 'b1-c001', valid: false, issues: ['Meaning not fully preserved.'] },
    { cueKey: 'b2-c001', valid: true, issues: [] },
  ],
});

const CORRECTION_RESPONSE_JSON = JSON.stringify({
  'b1-c001': 'A esperta raposa sentou cuidadosamente.',
});

const VALIDATOR_MALFORMED_JSON = JSON.stringify({ schemaVersion: '2.0' }); // no cues array

// ─── Supabase mock ────────────────────────────────────────────────────────────

interface MockSupabaseOptions {
  episodeStatus?: string;
  subtitlesStatus?: string | null;
  subtitlePromptVersion?: string | null;
  episodeNotFound?: boolean;
  noBlocks?: boolean;
  oneBlock?: boolean;
  noSentencesForBlock2?: boolean;
  blockTextMismatch?: boolean;
  existingCues?: Array<{ language: string; cue_order: number }>;
}

function makeSupabase(opts: MockSupabaseOptions = {}) {
  const episodeRow = {
    id: EPISODE_ID,
    title: 'Test Episode',
    synopsis: 'A synopsis.',
    cefr_level: 'B1',
    status: opts.episodeStatus ?? 'content_ready',
    content_version: 1,
    subtitles_status: opts.subtitlesStatus ?? null,
    subtitle_prompt_version: opts.subtitlePromptVersion ?? null,
  };

  const block1TextEn = opts.blockTextMismatch ? 'Something entirely different.' : BLOCK_1_TEXT;

  const blockRows = (() => {
    if (opts.noBlocks) return [];
    if (opts.oneBlock) return [{ id: BLOCK_1_ID, block_order: 1, text_en: block1TextEn }];
    return [
      { id: BLOCK_1_ID, block_order: 1, text_en: block1TextEn },
      { id: BLOCK_2_ID, block_order: 2, text_en: BLOCK_2_TEXT },
    ];
  })();

  const sentenceRows = opts.noSentencesForBlock2
    ? [{ block_id: BLOCK_1_ID, sentence_key: 'b1s01', sentence_order: 1, speaker: null, text_en: BLOCK_1_TEXT }]
    : [
        { block_id: BLOCK_1_ID, sentence_key: 'b1s01', sentence_order: 1, speaker: null, text_en: BLOCK_1_TEXT },
        { block_id: BLOCK_2_ID, sentence_key: 'b2s01', sentence_order: 1, speaker: null, text_en: BLOCK_2_TEXT },
      ];

  const insertCalls: unknown[] = [];
  const updateCalls: Array<{ table: string; data: unknown }> = [];

  const from = vi.fn((table: string) => ({
    select: (_fields: string) => ({
      eq: (_col: string, _val: unknown) => ({
        single: async () => {
          if (table === 'listening_episodes') {
            if (opts.episodeNotFound) return { data: null, error: { message: 'Not found' } };
            return { data: episodeRow, error: null };
          }
          return { data: null, error: { message: 'Not found' } };
        },
        order: async () => {
          if (table === 'listening_blocks') return { data: blockRows, error: null };
          return { data: [], error: null };
        },
      }),
      in: (_col: string, _vals: unknown[]) => ({
        order: async () => {
          if (table === 'listening_sentences') return { data: sentenceRows, error: null };
          if (table === 'listening_subtitle_cues') return { data: opts.existingCues ?? [], error: null };
          return { data: [], error: null };
        },
      }),
    }),
    insert: async (rows: unknown) => {
      insertCalls.push(rows);
      return { error: null };
    },
    delete: () => ({
      in: async () => ({ error: null }),
      eq: async () => ({ error: null }),
    }),
    update: (data: unknown) => {
      updateCalls.push({ table, data });
      return { eq: async () => ({ error: null }) };
    },
  }));

  return { from, _insertCalls: insertCalls, _updateCalls: updateCalls };
}

type MockSupabaseClient = ReturnType<typeof makeSupabase>;

function asSupabase(db: MockSupabaseClient): Parameters<typeof prepareListeningSubtitles>[2] {
  return db as unknown as Parameters<typeof prepareListeningSubtitles>[2];
}

// ─── Group 1: buildEnglishSubtitleCues ───────────────────────────────────────

describe('buildEnglishSubtitleCues', () => {
  // Case 1
  it('returns one cue for a sentence within the word limit', () => {
    const sentences: CanonicalSentence[] = [
      { sentenceKey: 'b1s01', sentenceOrder: 1, speaker: null, textEn: 'The quick fox sat down.' },
    ];
    const cues = buildEnglishSubtitleCues(sentences, 1, 'B1');
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('The quick fox sat down.');
  });

  // Case 2
  it('assigns cue key in b{block}-c{padded} format', () => {
    const sentences: CanonicalSentence[] = [
      { sentenceKey: 'b2s01', sentenceOrder: 1, speaker: null, textEn: 'Short text here.' },
    ];
    const cues = buildEnglishSubtitleCues(sentences, 2, 'B1');
    expect(cues[0].cueKey).toBe('b2-c001');
  });

  // Case 3
  it('assigns sequential cue orders starting at 1', () => {
    const sentences: CanonicalSentence[] = [
      { sentenceKey: 'b1s01', sentenceOrder: 1, speaker: 'Alice', textEn: 'Hello there friend.' },
      { sentenceKey: 'b1s02', sentenceOrder: 2, speaker: 'Bob', textEn: 'Nice to meet you.' },
    ];
    const cues = buildEnglishSubtitleCues(sentences, 1, 'B1');
    expect(cues.map(c => c.cueOrder)).toEqual([1, 2]);
  });

  // Case 4
  it('sets sourceSentenceKeys to the originating sentence key', () => {
    const sentences: CanonicalSentence[] = [
      { sentenceKey: 'b1s03', sentenceOrder: 3, speaker: null, textEn: 'A short line here.' },
    ];
    const cues = buildEnglishSubtitleCues(sentences, 1, 'B1');
    expect(cues[0].sourceSentenceKeys).toEqual(['b1s03']);
  });

  // Case 5
  it('splits a sentence that exceeds maxWords into multiple cues', () => {
    // B1 max = 13 words; this sentence has 14 words → must split at comma
    const long = 'She went to the market, and then she bought bread and milk and cheese.';
    const sentences: CanonicalSentence[] = [
      { sentenceKey: 'b1s01', sentenceOrder: 1, speaker: null, textEn: long },
    ];
    const cues = buildEnglishSubtitleCues(sentences, 1, 'B1');
    expect(cues.length).toBeGreaterThan(1);
  });

  // Case 6
  it('merges two short same-speaker sentences into one cue', () => {
    // 4 + 4 = 8 words ≤ B1 max 13; same speaker (null)
    const sentences: CanonicalSentence[] = [
      { sentenceKey: 'b1s01', sentenceOrder: 1, speaker: null, textEn: 'She smiled at him.' },
      { sentenceKey: 'b1s02', sentenceOrder: 2, speaker: null, textEn: 'He smiled back now.' },
    ];
    const cues = buildEnglishSubtitleCues(sentences, 1, 'B1');
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('She smiled at him. He smiled back now.');
  });

  // Case 7
  it('does not merge sentences from different speakers', () => {
    const sentences: CanonicalSentence[] = [
      { sentenceKey: 'b1s01', sentenceOrder: 1, speaker: 'Alice', textEn: 'Hello there now.' },
      { sentenceKey: 'b1s02', sentenceOrder: 2, speaker: 'Bob', textEn: 'Hi how are you.' },
    ];
    const cues = buildEnglishSubtitleCues(sentences, 1, 'B1');
    expect(cues).toHaveLength(2);
  });

  // Case 8
  it('all segments of a split sentence share the same source sentence key', () => {
    const long = 'She went to the market, and then she bought bread and milk and cheese.';
    const sentences: CanonicalSentence[] = [
      { sentenceKey: 'b1s01', sentenceOrder: 1, speaker: null, textEn: long },
    ];
    const cues = buildEnglishSubtitleCues(sentences, 1, 'B1');
    expect(cues.every(c => c.sourceSentenceKeys[0] === 'b1s01')).toBe(true);
  });

  // Case 9
  it('merged cue contains both source sentence keys', () => {
    const sentences: CanonicalSentence[] = [
      { sentenceKey: 'b1s01', sentenceOrder: 1, speaker: null, textEn: 'She smiled at him.' },
      { sentenceKey: 'b1s02', sentenceOrder: 2, speaker: null, textEn: 'He smiled back now.' },
    ];
    const cues = buildEnglishSubtitleCues(sentences, 1, 'B1');
    expect(cues).toHaveLength(1);
    expect(cues[0].sourceSentenceKeys).toEqual(['b1s01', 'b1s02']);
  });
});

// ─── Group 2: validateEnglishReconstruction ──────────────────────────────────

describe('validateEnglishReconstruction', () => {
  // Case 10
  it('passes when cue texts reconstruct the canonical block text', () => {
    const cues: EnglishCueDraft[] = [makeEnCue('b1-c001', 1, 1, 'The fox ran fast.')];
    expect(() => validateEnglishReconstruction('The fox ran fast.', cues)).not.toThrow();
  });

  // Case 11
  it('throws when the reconstructed text differs from the block text', () => {
    const cues: EnglishCueDraft[] = [makeEnCue('b1-c001', 1, 1, 'The fox ran slow.')];
    expect(() => validateEnglishReconstruction('The fox ran fast.', cues)).toThrow();
  });

  // Case 12
  it('normalises whitespace differences when comparing', () => {
    const cues: EnglishCueDraft[] = [makeEnCue('b1-c001', 1, 1, 'The fox  ran fast.')];
    expect(() => validateEnglishReconstruction('The fox ran fast.', cues)).not.toThrow();
  });

  // Case 13
  it('normaliseForReconstruction converts curly quotes and apostrophes to straight', () => {
    const lq = String.fromCharCode(0x201C); // " left double quotation mark
    const rq = String.fromCharCode(0x201D); // " right double quotation mark
    const ap = String.fromCharCode(0x2019); // ' right single quotation mark
    const withCurly = `He said ${lq}hello${rq} and it${ap}s fine.`;
    const normalised = normaliseForReconstruction(withCurly);
    expect(normalised).toBe("He said \"hello\" and it's fine.");
  });
});

// ─── Group 3: validateTranslationDeterministic ───────────────────────────────

describe('validateTranslationDeterministic', () => {
  // Case 14
  it('returns a Map of ValidatedTranslatedCue for a correct response', () => {
    const result = validateTranslationDeterministic(makeRawTranslation(), makeEnCuesMap());
    expect(result.get(1)).toHaveLength(1);
    expect(result.get(2)).toHaveLength(1);
    expect(result.get(1)![0].cueKey).toBe('b1-c001');
    expect(result.get(1)![0].textPtBr).toBe('A raposa ágil sentou.');
    expect(result.get(1)![0].textEn).toBe(BLOCK_1_TEXT);
  });

  // Case 15
  it('throws SubtitleTranslationParseError for a non-object response', () => {
    expect(() => validateTranslationDeterministic(null, makeEnCuesMap()))
      .toThrow(SubtitleTranslationParseError);
  });

  // Case 16
  it('throws when the response has no blocks array', () => {
    expect(() => validateTranslationDeterministic({}, makeEnCuesMap()))
      .toThrow(SubtitleTranslationValidationError);
  });

  // Case 17
  it('throws when only one block is returned instead of two', () => {
    const raw = { blocks: [{ blockOrder: 1, cues: [{ cueKey: 'b1-c001', textPtBr: 'texto' }] }] };
    expect(() => validateTranslationDeterministic(raw, makeEnCuesMap()))
      .toThrow(SubtitleTranslationValidationError);
  });

  // Case 18
  it('throws LISTENING_TRANSLATION_MISSING_CUE when block has too few cues', () => {
    const raw = makeRawTranslation({ block1Cues: [] });
    const err = getError(() => validateTranslationDeterministic(raw, makeEnCuesMap()));
    expect(err).toBeInstanceOf(SubtitleTranslationValidationError);
    expect((err as SubtitleTranslationValidationError).code).toBe('LISTENING_TRANSLATION_MISSING_CUE');
  });

  // Case 19
  it('throws LISTENING_TRANSLATION_EXTRA_CUE when block has too many cues', () => {
    const raw = makeRawTranslation({ block1Cues: [
      { cueKey: 'b1-c001', sourceSentenceKeys: ['b1s01'], textPtBr: 'texto um' },
      { cueKey: 'b1-c002', sourceSentenceKeys: ['b1s01'], textPtBr: 'texto dois' },
    ]});
    const err = getError(() => validateTranslationDeterministic(raw, makeEnCuesMap()));
    expect(err).toBeInstanceOf(SubtitleTranslationValidationError);
    expect((err as SubtitleTranslationValidationError).code).toBe('LISTENING_TRANSLATION_EXTRA_CUE');
  });

  // Case 20
  it('throws LISTENING_TRANSLATION_KEY_MISMATCH when cue key does not match', () => {
    const raw = makeRawTranslation({ block1Cues: [
      { cueKey: 'b1-c999', sourceSentenceKeys: ['b1s01'], textPtBr: 'texto' },
    ]});
    const err = getError(() => validateTranslationDeterministic(raw, makeEnCuesMap()));
    expect(err).toBeInstanceOf(SubtitleTranslationValidationError);
    expect((err as SubtitleTranslationValidationError).code).toBe('LISTENING_TRANSLATION_KEY_MISMATCH');
  });

  // Case 21
  it('throws when textPtBr is empty or whitespace', () => {
    const raw = makeRawTranslation({ block1Cues: [
      { cueKey: 'b1-c001', sourceSentenceKeys: ['b1s01'], textPtBr: '   ' },
    ]});
    expect(() => validateTranslationDeterministic(raw, makeEnCuesMap()))
      .toThrow(SubtitleTranslationValidationError);
  });

  // Case 22
  it('throws LISTENING_TRANSLATION_NUMBER_MISMATCH when English number is absent in Portuguese', () => {
    const enCuesWithNumber = new Map<1 | 2, EnglishCueDraft[]>([
      [1, [makeEnCue('b1-c001', 1, 1, 'She lives at 42 Baker Street.')]],
      [2, [makeEnCue('b2-c001', 1, 2, BLOCK_2_TEXT)]],
    ]);
    const raw = makeRawTranslation({ block1Cues: [
      { cueKey: 'b1-c001', sourceSentenceKeys: ['b1s01'], textPtBr: 'Ela mora na Baker Street.' },
    ]});
    const err = getError(() => validateTranslationDeterministic(raw, enCuesWithNumber));
    expect(err).toBeInstanceOf(SubtitleTranslationValidationError);
    expect((err as SubtitleTranslationValidationError).code).toBe('LISTENING_TRANSLATION_NUMBER_MISMATCH');
  });

  // Case 23
  it('throws when the translation appears to still be in English', () => {
    // ≥3 English function words and 0 Portuguese indicators
    const raw = makeRawTranslation({ block1Cues: [
      { cueKey: 'b1-c001', sourceSentenceKeys: ['b1s01'], textPtBr: 'The fox is here and she was the one who were present.' },
    ]});
    expect(() => validateTranslationDeterministic(raw, makeEnCuesMap()))
      .toThrow(SubtitleTranslationValidationError);
  });
});

// ─── Group 4: prepareListeningSubtitles — pure dry-run ───────────────────────

describe('prepareListeningSubtitles — pure dry-run (no supabase)', () => {
  // Case 24
  it('returns correct structure with zero cue counts', async () => {
    const result = await prepareListeningSubtitles({ episodeId: EPISODE_ID, dryRun: true });
    expect(result.status).toBe('ready');
    expect(result.episodeId).toBe(EPISODE_ID);
    expect(result.blockCount).toBe(2);
    expect(result.englishCueCount).toBe(0);
    expect(result.portugueseCueCount).toBe(0);
    expect(result.translationPromptVersion).toBe(TRANSLATION_PROMPT_VERSION);
  });

  // Case 25
  it('does not call the AI function in pure dry-run mode', async () => {
    const callAI = makeAI([]);
    await prepareListeningSubtitles({ episodeId: EPISODE_ID, dryRun: true }, callAI);
    expect(callAI).not.toHaveBeenCalled();
  });
});

// ─── Group 5: prepareListeningSubtitles — with database ──────────────────────

describe('prepareListeningSubtitles — with database', () => {
  // Case 26
  it('throws ListeningEpisodeNotFoundError when episode does not exist', async () => {
    const db = makeSupabase({ episodeNotFound: true });
    await expect(
      prepareListeningSubtitles({ episodeId: EPISODE_ID }, vi.fn(), asSupabase(db))
    ).rejects.toThrow(ListeningEpisodeNotFoundError);
  });

  // Case 27
  it('throws ListeningPublishedEpisodeImmutableError for a published episode', async () => {
    const db = makeSupabase({ episodeStatus: 'published' });
    await expect(
      prepareListeningSubtitles({ episodeId: EPISODE_ID }, vi.fn(), asSupabase(db))
    ).rejects.toThrow(ListeningPublishedEpisodeImmutableError);
  });

  // Case 28
  it('throws ListeningEpisodeNotReadyForSubtitlesError when status is not content_ready', async () => {
    const db = makeSupabase({ episodeStatus: 'draft' });
    await expect(
      prepareListeningSubtitles({ episodeId: EPISODE_ID }, vi.fn(), asSupabase(db))
    ).rejects.toThrow(ListeningEpisodeNotReadyForSubtitlesError);
  });

  // Case 29
  it('throws ListeningMissingBlocksError when episode has fewer than 2 blocks', async () => {
    const db = makeSupabase({ oneBlock: true });
    await expect(
      prepareListeningSubtitles({ episodeId: EPISODE_ID }, vi.fn(), asSupabase(db))
    ).rejects.toThrow(ListeningMissingBlocksError);
  });

  // Case 30
  it('throws ListeningMissingSentencesError when a block has no sentences', async () => {
    const db = makeSupabase({ noSentencesForBlock2: true });
    await expect(
      prepareListeningSubtitles({ episodeId: EPISODE_ID }, vi.fn(), asSupabase(db))
    ).rejects.toThrow(ListeningMissingSentencesError);
  });

  // Case 30b
  it('marks subtitles_status failed (not stuck at processing) when loading blocks/sentences/cues fails', async () => {
    const db = makeSupabase({ noSentencesForBlock2: true });
    await expect(
      prepareListeningSubtitles({ episodeId: EPISODE_ID }, vi.fn(), asSupabase(db))
    ).rejects.toThrow(ListeningMissingSentencesError);

    const episodeUpdates = db._updateCalls.filter(c => c.table === 'listening_episodes');
    const lastUpdate = episodeUpdates[episodeUpdates.length - 1];
    expect((lastUpdate.data as Record<string, unknown>).subtitles_status).toBe('failed');
  });

  // Case 31
  it('returns existing cue counts when subtitles are already ready at the same prompt version', async () => {
    const existingCues = [
      { language: 'en', cue_order: 1 },
      { language: 'en', cue_order: 2 },
      { language: 'pt-BR', cue_order: 1 },
      { language: 'pt-BR', cue_order: 2 },
    ];
    const db = makeSupabase({
      subtitlesStatus: 'ready',
      subtitlePromptVersion: TRANSLATION_PROMPT_VERSION,
      existingCues,
    });
    const callAI = makeAI([]);
    const result = await prepareListeningSubtitles({ episodeId: EPISODE_ID }, callAI, asSupabase(db));
    expect(result.status).toBe('ready');
    expect(result.englishCueCount).toBe(2);
    expect(result.portugueseCueCount).toBe(2);
    expect(callAI).not.toHaveBeenCalled();
  });

  // Case 32
  it('throws ListeningSubtitlesAlreadyExistError when status is processing and forceRegeneration is false', async () => {
    const db = makeSupabase({ subtitlesStatus: 'processing' });
    await expect(
      prepareListeningSubtitles({ episodeId: EPISODE_ID, forceRegeneration: false }, vi.fn(), asSupabase(db))
    ).rejects.toThrow(ListeningSubtitlesAlreadyExistError);
  });

  // Case 33
  it('calls AI translation once per block (batched) then validates each block — 4 total AI calls', async () => {
    const db = makeSupabase();
    const callAI = makeAI([TRANSLATION_SUCCESS_JSON, TRANSLATION_SUCCESS_JSON, VALIDATOR_SUCCESS_JSON, VALIDATOR_SUCCESS_JSON]);
    const result = await prepareListeningSubtitles({ episodeId: EPISODE_ID }, callAI, asSupabase(db));
    expect(result.status).toBe('ready');
    expect(callAI).toHaveBeenCalledTimes(4);
  });

  // Case 34
  it('throws ListeningEnglishReconstructionFailedError when block text does not match its sentences', async () => {
    const db = makeSupabase({ blockTextMismatch: true });
    // Block 1 text_en = "Something entirely different." but sentence text_en = BLOCK_1_TEXT
    await expect(
      prepareListeningSubtitles({ episodeId: EPISODE_ID }, vi.fn(), asSupabase(db))
    ).rejects.toThrow(ListeningEnglishReconstructionFailedError);
  });

  // Case 35
  it('makes a targeted correction cycle when block validation fails, then re-validates', async () => {
    const db = makeSupabase();
    // Translate b1, translate b2 → validate b1 (fail) → correct b1 (targeted) → re-validate b1 (pass) → validate b2 (pass)
    const callAI = makeAI([
      TRANSLATION_SUCCESS_JSON,
      TRANSLATION_SUCCESS_JSON,
      VALIDATOR_FAIL_JSON,
      CORRECTION_RESPONSE_JSON,
      VALIDATOR_SUCCESS_JSON,
      VALIDATOR_SUCCESS_JSON,
    ]);
    const result = await prepareListeningSubtitles({ episodeId: EPISODE_ID }, callAI, asSupabase(db));
    expect(result.status).toBe('ready');
    expect(callAI).toHaveBeenCalledTimes(6);
  });

  // Case 35b
  it('the correction call asks only for the failing cue, with its specific issue, and lists the still-valid cue separately', async () => {
    const db = makeSupabase();
    const callAI = makeAI([
      TRANSLATION_SUCCESS_JSON,
      TRANSLATION_SUCCESS_JSON,
      VALIDATOR_FAIL_JSON,
      CORRECTION_RESPONSE_JSON,
      VALIDATOR_SUCCESS_JSON,
      VALIDATOR_SUCCESS_JSON,
    ]);
    await prepareListeningSubtitles({ episodeId: EPISODE_ID }, callAI, asSupabase(db));
    const correctionPrompt = (callAI as ReturnType<typeof vi.fn>).mock.calls[3][1] as string;
    expect(correctionPrompt).toContain('Meaning not fully preserved.');
    expect(correctionPrompt).toContain('b1-c001');
  });

  // Case 36
  it('returns ready result after a successful targeted correction cycle', async () => {
    const db = makeSupabase();
    const callAI = makeAI([
      TRANSLATION_SUCCESS_JSON,
      TRANSLATION_SUCCESS_JSON,
      VALIDATOR_FAIL_JSON,
      CORRECTION_RESPONSE_JSON,
      VALIDATOR_SUCCESS_JSON,
      VALIDATOR_SUCCESS_JSON,
    ]);
    const result = await prepareListeningSubtitles({ episodeId: EPISODE_ID }, callAI, asSupabase(db));
    expect(result.englishCueCount).toBe(2);
    expect(result.portugueseCueCount).toBe(2);
    expect(result.translationPromptVersion).toBe(TRANSLATION_PROMPT_VERSION);
  });

  // Case 37
  it('throws ListeningTranslationCorrectionFailedError with the exact failing cueKey/issue after exhausting the correction round limit', async () => {
    const db = makeSupabase();
    // b1 fails every round; MAX_QUALITY_CORRECTION_ROUNDS = 2, so: validate,
    // correct, validate, correct, validate (still failing) → give up.
    const callAI = makeAI([
      TRANSLATION_SUCCESS_JSON, TRANSLATION_SUCCESS_JSON,
      VALIDATOR_FAIL_JSON, CORRECTION_RESPONSE_JSON,
      VALIDATOR_FAIL_JSON, CORRECTION_RESPONSE_JSON,
      VALIDATOR_FAIL_JSON,
    ]);
    const err = await getRejection(
      prepareListeningSubtitles({ episodeId: EPISODE_ID }, callAI, asSupabase(db))
    );
    expect(err).toBeInstanceOf(ListeningTranslationCorrectionFailedError);
    expect((err as ListeningTranslationCorrectionFailedError).message).toContain('b1-c001');
    expect((err as ListeningTranslationCorrectionFailedError).message).toContain('Meaning not fully preserved.');
    expect(callAI).toHaveBeenCalledTimes(7);
  });

  // Case 37b
  it('a malformed validator response is retried as a validator error, not treated as an invalid translation', async () => {
    const db = makeSupabase();
    // b1: malformed → retried → pass. b2: pass immediately.
    const callAI = makeAI([
      TRANSLATION_SUCCESS_JSON,
      TRANSLATION_SUCCESS_JSON,
      VALIDATOR_MALFORMED_JSON,
      VALIDATOR_SUCCESS_JSON,
      VALIDATOR_SUCCESS_JSON,
    ]);
    const result = await prepareListeningSubtitles({ episodeId: EPISODE_ID }, callAI, asSupabase(db));
    expect(result.status).toBe('ready');
    expect(callAI).toHaveBeenCalledTimes(5);
  });

  // Case 37c
  it('throws a distinct validator error (not a correction failure) when every validator attempt is malformed', async () => {
    const db = makeSupabase();
    const callAI = makeAI([
      TRANSLATION_SUCCESS_JSON, TRANSLATION_SUCCESS_JSON,
      VALIDATOR_MALFORMED_JSON, VALIDATOR_MALFORMED_JSON,
    ]);
    const err = await getRejection(
      prepareListeningSubtitles({ episodeId: EPISODE_ID }, callAI, asSupabase(db))
    );
    expect(err).not.toBeInstanceOf(ListeningTranslationCorrectionFailedError);
    expect((err as { code?: string }).code).toBe('LISTENING_TRANSLATION_VALIDATOR_MALFORMED_RESPONSE');
  });

  // Case 38b
  it('repairs a single missing cue by re-translating only that cue, then proceeds without failing the episode', async () => {
    const db = makeSupabase();
    // Block 1's batch call omits its only cue; block 2's batch call (the
    // same fixture reused) still resolves b2-c001 normally.
    const partialTranslationBlock1 = JSON.stringify(makeTranslationBatchResponse({ block1Cues: [] }));
    const missingCueRepairResponse = JSON.stringify({
      cues: [{ cueKey: 'b1-c001', textPtBr: 'A raposa ágil sentou.' }],
    });
    const callAI = makeAI([
      partialTranslationBlock1, // 1. translate block 1: its only cue is missing
      partialTranslationBlock1, // 2. translate block 2: b2-c001 resolves fine
      missingCueRepairResponse, // 3. targeted repair: only the missing cue
      VALIDATOR_SUCCESS_JSON,   // 4. AI semantic validation block 1
      VALIDATOR_SUCCESS_JSON,   // 5. AI semantic validation block 2
    ]);

    const result = await prepareListeningSubtitles({ episodeId: EPISODE_ID }, callAI, asSupabase(db));

    expect(result.status).toBe('ready');
    expect(result.englishCueCount).toBe(2);
    expect(result.portugueseCueCount).toBe(2);
    expect(callAI).toHaveBeenCalledTimes(5);

    // The repair call must ask for only the missing cue, not the full set.
    const repairPrompt = (callAI as ReturnType<typeof vi.fn>).mock.calls[2][1] as string;
    expect(repairPrompt).toContain('b1-c001');
  });

  // Case 38c
  it('does not repair indefinitely: gives up after the repair round limit and marks the episode failed', async () => {
    const db = makeSupabase();
    const alwaysPartialBlock1 = JSON.stringify(makeTranslationBatchResponse({ block1Cues: [] }));
    const repairStillEmpty = JSON.stringify({ cues: [] }); // repair keeps omitting the cue
    const callAI = makeAI([alwaysPartialBlock1, alwaysPartialBlock1, repairStillEmpty, repairStillEmpty]);

    await expect(
      prepareListeningSubtitles({ episodeId: EPISODE_ID }, callAI, asSupabase(db))
    ).rejects.toThrow(SubtitleTranslationValidationError);

    // 2 initial translation batches (one per block) + 2 bounded repair rounds = 4 calls, never unbounded.
    expect(callAI).toHaveBeenCalledTimes(4);
  });

  // Case 38d
  it('marks subtitles_status failed (not stuck at processing) when the translation AI call itself throws', async () => {
    const db = makeSupabase();
    const callAI = makeAI(['this is not valid json at all, no braces']);

    await expect(
      prepareListeningSubtitles({ episodeId: EPISODE_ID }, callAI, asSupabase(db))
    ).rejects.toThrow();

    const episodeUpdates = db._updateCalls.filter(c => c.table === 'listening_episodes');
    expect(episodeUpdates.some(c => (c.data as Record<string, unknown>).subtitles_status === 'processing')).toBe(true);
    // The critical assertion: a retry must not find the episode stuck at
    // 'processing' (which would block it with LISTENING_SUBTITLES_ALREADY_EXIST).
    const lastUpdate = episodeUpdates[episodeUpdates.length - 1];
    expect((lastUpdate.data as Record<string, unknown>).subtitles_status).toBe('failed');
  });

  // Case 38e
  it('marks subtitles_status failed (not stuck at processing) when the missing-cue repair AI call itself throws — the exact failure seen live in production', async () => {
    const db = makeSupabase();
    const alwaysPartialBlock1 = JSON.stringify(makeTranslationBatchResponse({ block1Cues: [] }));
    const callAI = makeAI([alwaysPartialBlock1, alwaysPartialBlock1, 'this is not valid json at all, no braces']);

    await expect(
      prepareListeningSubtitles({ episodeId: EPISODE_ID }, callAI, asSupabase(db))
    ).rejects.toThrow();

    const episodeUpdates = db._updateCalls.filter(c => c.table === 'listening_episodes');
    expect(episodeUpdates.some(c => (c.data as Record<string, unknown>).subtitles_status === 'processing')).toBe(true);
    const lastUpdate = episodeUpdates[episodeUpdates.length - 1];
    expect((lastUpdate.data as Record<string, unknown>).subtitles_status).toBe('failed');
  });

  // Case 38
  it('does not insert subtitle cues when dryRun is true even with a supabase client', async () => {
    const db = makeSupabase();
    const callAI = makeAI([TRANSLATION_SUCCESS_JSON, TRANSLATION_SUCCESS_JSON, VALIDATOR_SUCCESS_JSON, VALIDATOR_SUCCESS_JSON]);
    const result = await prepareListeningSubtitles(
      { episodeId: EPISODE_ID, dryRun: true },
      callAI,
      asSupabase(db),
    );
    expect(result.status).toBe('ready');
    expect(db._insertCalls).toHaveLength(0);
  });
});
