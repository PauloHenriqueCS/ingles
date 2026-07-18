import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { azureTicksToMilliseconds } from './normalize-listening-bookmarks';
import { deduplicateListeningWordEvents } from './normalize-listening-word-boundaries';
import { validateListeningBookmarkEvents } from './validate-listening-bookmarks';
import { validateListeningAudioBuffer } from './validate-listening-audio';
import { computeListeningAudioHash } from './hash-listening-audio';
import { buildStagingAudioPath } from './listening-audio-config';
import { DURATION_MIN_MS, DURATION_MAX_MS } from './listening-audio-config';
import type { RawListeningBookmarkEvent, RawListeningWordBoundaryEvent } from './listening-audio-types';
import { createMockGatewayDeps } from '../../../../api/__tests__/_ai-gateway-test-helpers';

// ─── AI Gateway mock ─────────────────────────────────────────────────────────
// synthesizeListeningBlock now wraps its physical Azure calls with the AI
// Gateway (Etapa 9). Gateway behavior itself is covered by
// synthesize-listening-block-gateway.test.ts — this file only needs
// getProductionDeps() to resolve to 'legacy' so it never touches Supabase.

const { gw } = vi.hoisted(() => {
  return { gw: {} as ReturnType<typeof import('../../../../api/__tests__/_ai-gateway-test-helpers').createMockGatewayDeps> };
});

vi.mock('../../../../api/_ai-gateway/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../api/_ai-gateway/index')>();
  return { ...actual, getProductionDeps: () => gw.mockDeps };
});

// ─── Azure SDK mock ──────────────────────────────────────────────────────────

interface MockSynthState {
  shouldCancel: boolean;
  cancellationRetryable: boolean;
  audioData: ArrayBuffer;
  audioDuration: number;
  bookmarkEvents: Array<{ text: string; audioOffset: number }>;
  wordEvents: Array<{
    text: string; audioOffset: number; duration: number;
    textOffset: number; wordLength: number; boundaryType: string;
  }>;
  throwOnSynthesize: Error | null;
  closeCallCount: number;
}

const mockState: MockSynthState = {
  shouldCancel: false,
  cancellationRetryable: false,
  audioData: new ArrayBuffer(50_000),
  audioDuration: 3_000_000_000, // 5 minutes in ticks
  bookmarkEvents: [],
  wordEvents: [],
  throwOnSynthesize: null,
  closeCallCount: 0,
};

const mockSpeechConfigInstance = {
  speechSynthesisOutputFormat: 0 as number,
  speechSynthesisVoiceName: '' as string,
  close: vi.fn(),
};

let capturedSynthesizer: {
  bookmarkReached: ((s: null, e: { text: string; audioOffset: number }) => void) | null;
  wordBoundary: ((s: null, e: {
    text: string; audioOffset: number; duration: number;
    textOffset: number; wordLength: number; boundaryType: string;
  }) => void) | null;
  speakSsmlAsync: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} | null = null;

vi.mock('microsoft-cognitiveservices-speech-sdk', () => {
  const SpeechConfig = {
    fromSubscription: vi.fn(() => mockSpeechConfigInstance),
    fromSubscriptionKey: vi.fn(() => mockSpeechConfigInstance),
  };

  const SpeechSynthesizer = vi.fn().mockImplementation(function(this: unknown) {
    const synth = {
      bookmarkReached: null as ((s: null, e: { text: string; audioOffset: number }) => void) | null,
      wordBoundary: null as unknown,
      synthesisStarted: null as unknown,
      synthesisCompleted: null as unknown,
      synthesisCanceled: null as unknown,
      speakSsmlAsync: vi.fn((
        _ssml: string,
        resolve: (r: object) => void,
        _reject: (e: string) => void,
      ) => {
        if (mockState.throwOnSynthesize) {
          throw mockState.throwOnSynthesize;
        }
        // Infer block number from SSML so multi-block episode tests fire correct bookmark names
        const blockNum = _ssml.includes('block2') ? 2 : 1;
        const adaptedBookmarks = mockState.bookmarkEvents.map(bm => ({
          ...bm,
          text: bm.text
            .replace(/^block-1-/, `block-${blockNum}-`)
            .replace(/^b1s/, blockNum === 2 ? 'b2s' : 'b1s'),
        }));
        for (const bm of adaptedBookmarks) {
          synth.bookmarkReached?.(null, bm);
        }
        for (const w of mockState.wordEvents) {
          (synth.wordBoundary as ((s: null, e: typeof w) => void) | null)?.(null, w);
        }
        if (mockState.shouldCancel) {
          resolve({ reason: 0, audioData: new ArrayBuffer(0), audioDuration: 0, resultId: 'x', errorDetails: 'canceled' });
        } else {
          resolve({ reason: 1, audioData: mockState.audioData, audioDuration: mockState.audioDuration, resultId: 'r1', errorDetails: '' });
        }
      }),
      close: vi.fn(() => { mockState.closeCallCount++; }),
    };
    capturedSynthesizer = synth;
    return synth;
  });

  return {
    SpeechConfig,
    SpeechSynthesizer,
    SpeechSynthesisOutputFormat: { Audio24Khz96KBitRateMonoMp3: 38 },
    ResultReason: { SynthesizingAudioCompleted: 1, Canceled: 0 },
    CancellationDetails: {
      fromResult: vi.fn(() => ({
        reason: mockState.cancellationRetryable ? 0 : 1,
        ErrorCode: mockState.cancellationRetryable ? 5 : 1, // 5=ServiceError, 1=AuthFailure
        errorDetails: 'mock cancel',
      })),
    },
    CancellationReason: { Error: 1, EndOfStream: 0 },
    CancellationErrorCode: {
      AuthenticationFailure: 1, 1: 'AuthenticationFailure',
      BadRequest: 4, 4: 'BadRequest',
      ServiceError: 5, 5: 'ServiceError',
      NoError: 0, 0: 'NoError',
    },
  };
});

// ─── Supabase mock ───────────────────────────────────────────────────────────

interface MockSupabaseOptions {
  episode?: object | null;
  blocks?: object[];
  sentences?: object[];
  assetData?: object | null;
  blockUpdateError?: string;
  episodeUpdateError?: string;
  storageUploadError?: string;
  assetUpsertData?: { id: string } | null;
}

const SSML_GENERATOR_VERSION = 'listening-ssml-generator-v1';

const DEFAULT_BLOCKS = [
  { id: 'blk-1', block_order: 1, ssml: '<speak>block1</speak>', ssml_status: 'ready', ssml_generator_version: SSML_GENERATOR_VERSION, ssml_content_hash: 'abc123hash', audio_status: null },
  { id: 'blk-2', block_order: 2, ssml: '<speak>block2</speak>', ssml_status: 'ready', ssml_generator_version: SSML_GENERATOR_VERSION, ssml_content_hash: 'def456hash', audio_status: null },
];

const DEFAULT_SENTENCES = [
  { block_id: 'blk-1', sentence_key: 'b1s01', sentence_order: 1 },
  { block_id: 'blk-2', sentence_key: 'b2s01', sentence_order: 1 },
];

const DEFAULT_EPISODE = { id: 'ep-1', status: 'content_ready', cefr_level: 'B1', content_version: 1, voice_name: 'en-US-AvaMultilingualNeural', locale: 'en-US' };

function makeSupabase(opts: MockSupabaseOptions = {}) {
  const updateCalls: Array<{ table: string; data: unknown }> = [];
  const insertCalls: Array<{ table: string; data: unknown }> = [];

  const episode = opts.episode !== undefined ? opts.episode : DEFAULT_EPISODE;
  const blocks = opts.blocks ?? DEFAULT_BLOCKS;
  const sentences = opts.sentences ?? DEFAULT_SENTENCES;
  const assetUpsertData = opts.assetUpsertData !== undefined ? opts.assetUpsertData : { id: 'asset-1' };

  const from = vi.fn((table: string) => {
    if (table === 'listening_episodes') {
      return {
        select: () => ({ eq: () => ({ single: async () => ({ data: episode, error: episode === null ? { message: 'not found' } : null }) }) }),
        update: (data: unknown) => ({ eq: async () => { updateCalls.push({ table, data }); return { error: opts.episodeUpdateError ? { message: opts.episodeUpdateError } : null }; } }),
      };
    }
    if (table === 'listening_blocks') {
      return {
        select: () => ({ eq: () => ({ order: async () => ({ data: blocks, error: null }) }) }),
        update: (data: unknown) => ({ eq: async () => { updateCalls.push({ table, data }); return { error: opts.blockUpdateError ? { message: opts.blockUpdateError } : null }; } }),
      };
    }
    if (table === 'listening_sentences') {
      return { select: () => ({ in: () => ({ order: async () => ({ data: sentences, error: null }) }) }) };
    }
    if (table === 'listening_audio_assets') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({ maybeSingle: async () => ({ data: opts.assetData !== undefined ? opts.assetData : null, error: null }) }),
                maybeSingle: async () => ({ data: opts.assetData !== undefined ? opts.assetData : null, error: null }),
              }),
              maybeSingle: async () => ({ data: opts.assetData !== undefined ? opts.assetData : null, error: null }),
            }),
          }),
        }),
        upsert: () => ({ select: () => ({ single: async () => ({ data: assetUpsertData, error: assetUpsertData === null ? { message: 'upsert failed' } : null }) }) }),
      };
    }
    if (table === 'listening_bookmark_timings' || table === 'listening_word_timings') {
      return {
        delete: () => ({ eq: async () => ({ error: null }) }),
        insert: async (rows: unknown) => { insertCalls.push({ table, data: rows }); return { error: null }; },
      };
    }
    return {};
  });

  const storage = {
    from: vi.fn(() => ({
      upload: vi.fn(async () => ({ error: opts.storageUploadError ? { message: opts.storageUploadError } : null })),
      list: vi.fn(async () => ({ data: [], error: null })),
    })),
  };

  return { client: { from, storage } as unknown as SupabaseClient, _updateCalls: updateCalls, _insertCalls: insertCalls };
}

// Reset mock state before each test
beforeEach(() => {
  mockState.shouldCancel = false;
  mockState.cancellationRetryable = false;
  mockState.audioData = new ArrayBuffer(50_000);
  mockState.audioDuration = 3_000_000_000;
  mockState.bookmarkEvents = [
    { text: 'block-1-start', audioOffset: 100_000 },
    { text: 'b1s01', audioOffset: 500_000 },
    { text: 'block-1-end', audioOffset: 2_900_000_000 },
  ];
  mockState.wordEvents = [
    { text: 'Hello', audioOffset: 520_000, duration: 80_000, textOffset: 0, wordLength: 5, boundaryType: 'Word' },
  ];
  mockState.throwOnSynthesize = null;
  mockState.closeCallCount = 0;
  capturedSynthesizer = null;
  vi.clearAllMocks();
  Object.assign(gw, createMockGatewayDeps());
  (gw as ReturnType<typeof createMockGatewayDeps>).resetDefaults();
});

// ─── Group 1: azureTicksToMilliseconds ───────────────────────────────────────

describe('azureTicksToMilliseconds', () => {
  it('case 1: converts standard tick value to milliseconds', () => {
    expect(azureTicksToMilliseconds(10_000)).toBe(1); // 10,000 ticks = 1 ms
  });

  it('case 2: converts large tick value (5 min) to correct ms', () => {
    // 5 min = 300,000 ms = 3,000,000,000 ticks
    expect(azureTicksToMilliseconds(3_000_000_000)).toBe(300_000);
  });

  it('case 3: accepts zero ticks and returns 0', () => {
    expect(azureTicksToMilliseconds(0)).toBe(0);
  });

  it('case 4: throws on negative ticks', () => {
    expect(() => azureTicksToMilliseconds(-1)).toThrow();
  });

  it('case 5: throws on NaN', () => {
    expect(() => azureTicksToMilliseconds(NaN)).toThrow();
  });

  it('case 6: accepts numeric string', () => {
    expect(azureTicksToMilliseconds('20000')).toBe(2);
  });
});

// ─── Group 2: deduplicateListeningWordEvents ──────────────────────────────────

describe('deduplicateListeningWordEvents', () => {
  it('case 7: passes through unique events unchanged', () => {
    const events: RawListeningWordBoundaryEvent[] = [
      { text: 'Hello', audioOffsetTicks: 1000, durationTicks: 500, textOffset: 0, wordLength: 5, boundaryType: 'Word', receivedOrder: 0 },
      { text: 'world', audioOffsetTicks: 2000, durationTicks: 500, textOffset: 6, wordLength: 5, boundaryType: 'Word', receivedOrder: 1 },
    ];
    expect(deduplicateListeningWordEvents(events)).toHaveLength(2);
  });

  it('case 8: removes truly duplicate events (same text, offset, textOffset)', () => {
    const events: RawListeningWordBoundaryEvent[] = [
      { text: 'Hello', audioOffsetTicks: 1000, durationTicks: 500, textOffset: 0, wordLength: 5, boundaryType: 'Word', receivedOrder: 0 },
      { text: 'Hello', audioOffsetTicks: 1000, durationTicks: 500, textOffset: 0, wordLength: 5, boundaryType: 'Word', receivedOrder: 1 },
    ];
    expect(deduplicateListeningWordEvents(events)).toHaveLength(1);
  });

  it('case 9: preserves repeated words at different offsets', () => {
    const events: RawListeningWordBoundaryEvent[] = [
      { text: 'the', audioOffsetTicks: 1000, durationTicks: 200, textOffset: 0, wordLength: 3, boundaryType: 'Word', receivedOrder: 0 },
      { text: 'the', audioOffsetTicks: 5000, durationTicks: 200, textOffset: 10, wordLength: 3, boundaryType: 'Word', receivedOrder: 1 },
    ];
    expect(deduplicateListeningWordEvents(events)).toHaveLength(2);
  });
});

// ─── Group 3: validateListeningBookmarkEvents ─────────────────────────────────

describe('validateListeningBookmarkEvents', () => {
  const makeEvent = (name: string, offset: number, order: number): RawListeningBookmarkEvent => ({
    bookmarkName: name, audioOffsetTicks: offset, receivedOrder: order,
  });

  const expected = ['block-1-start', 'b1s01', 'b1s02', 'block-1-end'];

  it('case 10: valid events → valid=true, empty arrays', () => {
    const events = [
      makeEvent('block-1-start', 0, 0),
      makeEvent('b1s01', 100, 1),
      makeEvent('b1s02', 200, 2),
      makeEvent('block-1-end', 300, 3),
    ];
    const result = validateListeningBookmarkEvents(events, expected);
    expect(result.valid).toBe(true);
    expect(result.missing).toHaveLength(0);
    expect(result.duplicated).toHaveLength(0);
    expect(result.unexpected).toHaveLength(0);
  });

  it('case 11: missing bookmark → reported in missing', () => {
    const events = [makeEvent('block-1-start', 0, 0), makeEvent('b1s01', 100, 1), makeEvent('block-1-end', 300, 3)];
    const result = validateListeningBookmarkEvents(events, expected);
    expect(result.missing).toContain('b1s02');
  });

  it('case 12: duplicated bookmark → reported in duplicated', () => {
    const events = [
      makeEvent('block-1-start', 0, 0), makeEvent('b1s01', 100, 1),
      makeEvent('b1s01', 100, 2), makeEvent('b1s02', 200, 3), makeEvent('block-1-end', 300, 4),
    ];
    const result = validateListeningBookmarkEvents(events, expected);
    expect(result.duplicated).toContain('b1s01');
  });

  it('case 13: unexpected bookmark → reported in unexpected', () => {
    const events = [
      makeEvent('block-1-start', 0, 0), makeEvent('b1s01', 100, 1),
      makeEvent('intruder', 150, 2), makeEvent('b1s02', 200, 3), makeEvent('block-1-end', 300, 4),
    ];
    const result = validateListeningBookmarkEvents(events, expected);
    expect(result.unexpected).toContain('intruder');
  });

  it('case 14: out-of-order bookmark → reported in outOfOrder', () => {
    const events = [
      makeEvent('block-1-start', 0, 0), makeEvent('b1s02', 100, 1),
      makeEvent('b1s01', 200, 2), makeEvent('block-1-end', 300, 3),
    ];
    const result = validateListeningBookmarkEvents(events, expected);
    expect(result.outOfOrder.length).toBeGreaterThan(0);
  });
});

// ─── Group 4: validateListeningAudioBuffer ────────────────────────────────────

describe('validateListeningAudioBuffer', () => {
  const validDurationMs = 5 * 60 * 1000; // 5 minutes

  it('case 15: valid buffer and duration → valid=true', () => {
    const result = validateListeningAudioBuffer(new ArrayBuffer(50_000), validDurationMs);
    expect(result.valid).toBe(true);
    expect(result.durationStatus).toBe('valid');
  });

  it('case 16: empty buffer → valid=false with LISTENING_AUDIO_EMPTY', () => {
    const result = validateListeningAudioBuffer(new ArrayBuffer(0), validDurationMs);
    expect(result.valid).toBe(false);
    expect(result.failureCode).toBe('LISTENING_AUDIO_EMPTY');
  });

  it('case 17: duration below minimum → valid=false with LISTENING_AUDIO_DURATION_INVALID', () => {
    const result = validateListeningAudioBuffer(new ArrayBuffer(50_000), DURATION_MIN_MS - 1000);
    expect(result.valid).toBe(false);
    expect(result.failureCode).toBe('LISTENING_AUDIO_DURATION_INVALID');
  });

  it('case 18: duration above maximum → valid=false', () => {
    const result = validateListeningAudioBuffer(new ArrayBuffer(50_000), DURATION_MAX_MS + 1000);
    expect(result.valid).toBe(false);
  });

  it('case 19: duration slightly off from target → needs_review', () => {
    // 4 min 20 sec = 4*60*1000 + 20*1000 = 260,000 ms — within [240000, 360000] but >30s from 300000
    const result = validateListeningAudioBuffer(new ArrayBuffer(50_000), 260_000);
    expect(result.valid).toBe(true);
    expect(result.durationStatus).toBe('needs_review');
  });
});

// ─── Group 5: computeListeningAudioHash ──────────────────────────────────────

describe('computeListeningAudioHash', () => {
  it('case 20: same buffer produces same hash (deterministic)', () => {
    const buf = new ArrayBuffer(100);
    new Uint8Array(buf).fill(42);
    expect(computeListeningAudioHash(buf)).toBe(computeListeningAudioHash(buf));
  });

  it('case 21: different buffers produce different hashes', () => {
    const buf1 = new ArrayBuffer(100);
    const buf2 = new ArrayBuffer(100);
    new Uint8Array(buf1).fill(1);
    new Uint8Array(buf2).fill(2);
    expect(computeListeningAudioHash(buf1)).not.toBe(computeListeningAudioHash(buf2));
  });
});

// ─── Group 6: buildStagingAudioPath ──────────────────────────────────────────

describe('buildStagingAudioPath', () => {
  it('case 22: uses deterministic path structure', () => {
    const path = buildStagingAudioPath('B1', 'ep-123', 1, 'abcdef1234567890', 1);
    expect(path).toBe('staging/B1/ep-123/v1/ssml-abcdef12/block-01.mp3');
  });

  it('case 23: block order 2 produces block-02.mp3', () => {
    const path = buildStagingAudioPath('B1', 'ep-1', 1, 'aaaaaaaaaaaaaaaa', 2);
    expect(path).toContain('block-02.mp3');
  });
});

// ─── Group 7: synthesizeListeningBlock + synthesizeListeningEpisode ───────────

import { synthesizeListeningBlock, ListeningAudioBookmarksMissingError, ListeningAudioEmptyError, ListeningAzureSynthesisCanceledError } from './synthesize-listening-block';
import {
  synthesizeListeningEpisode,
  ListeningEpisodeNotFoundError,
  ListeningPublishedEpisodeImmutableError,
  ListeningInvalidBlockStructureError,
  ListeningSsmlNotReadyError,
} from './synthesize-listening-episode';
import { buildListeningAzureSpeechConfig } from './listening-audio-config';

const TEST_AZURE_CONFIG = buildListeningAzureSpeechConfig(
  'test-key', 'eastus', 'en-US-AvaMultilingualNeural', 'en-US',
);

function makeBlockInput(overrides = {}) {
  return {
    blockId: 'blk-1',
    blockOrder: 1 as const,
    episodeId: 'ep-1',
    cefrLevel: 'B1',
    contentVersion: 1,
    ssml: '<speak><voice>test</voice></speak>',
    ssmlHash: 'abc123hash',
    expectedBookmarks: ['block-1-start', 'b1s01', 'block-1-end'],
    ...overrides,
  };
}

it('case 24: synthesizeListeningBlock uses the correct voice name', async () => {
  const { client } = makeSupabase();
  await synthesizeListeningBlock(makeBlockInput(), TEST_AZURE_CONFIG, client, 'B1');
  expect(mockSpeechConfigInstance.speechSynthesisVoiceName).toBe('en-US-AvaMultilingualNeural');
});

it('case 25: synthesizeListeningBlock uses the configured output format value', async () => {
  const { client } = makeSupabase();
  await synthesizeListeningBlock(makeBlockInput(), TEST_AZURE_CONFIG, client, 'B1');
  expect(mockSpeechConfigInstance.speechSynthesisOutputFormat).toBe(38);
});

it('case 26: synthesizeListeningBlock captures the bookmark-start event', async () => {
  const { client } = makeSupabase();
  const result = await synthesizeListeningBlock(makeBlockInput(), TEST_AZURE_CONFIG, client, 'B1');
  expect(result.bookmarkCount).toBeGreaterThan(0);
});

it('case 27: synthesizeListeningBlock captures the bookmark-end event', async () => {
  const { client } = makeSupabase();
  const result = await synthesizeListeningBlock(makeBlockInput(), TEST_AZURE_CONFIG, client, 'B1');
  expect(result.bookmarkCount).toBeGreaterThanOrEqual(3); // start + sentence + end
});

it('case 28: synthesizeListeningBlock captures sentence bookmark', async () => {
  const { client } = makeSupabase();
  const result = await synthesizeListeningBlock(makeBlockInput(), TEST_AZURE_CONFIG, client, 'B1');
  expect(result.bookmarkCount).toBeGreaterThanOrEqual(3);
});

it('case 29: synthesizeListeningBlock rejects missing bookmark', async () => {
  mockState.bookmarkEvents = [
    { text: 'block-1-start', audioOffset: 100_000 },
    // b1s01 missing
    { text: 'block-1-end', audioOffset: 2_900_000_000 },
  ];
  const { client } = makeSupabase();
  await expect(synthesizeListeningBlock(makeBlockInput(), TEST_AZURE_CONFIG, client, 'B1'))
    .rejects.toThrow(ListeningAudioBookmarksMissingError);
});

it('case 30: synthesizeListeningBlock rejects empty audio', async () => {
  mockState.audioData = new ArrayBuffer(0);
  mockState.audioDuration = 0;
  mockState.bookmarkEvents = [];
  const { client } = makeSupabase();
  await expect(synthesizeListeningBlock(makeBlockInput(), TEST_AZURE_CONFIG, client, 'B1'))
    .rejects.toThrow(ListeningAudioEmptyError);
});

it('case 31: synthesizeListeningBlock rejects cancellation', async () => {
  mockState.shouldCancel = true;
  mockState.cancellationRetryable = false;
  const { client } = makeSupabase();
  await expect(synthesizeListeningBlock(makeBlockInput(), TEST_AZURE_CONFIG, client, 'B1'))
    .rejects.toThrow();
});

it('case 32: close() is called on success', async () => {
  const { client } = makeSupabase();
  await synthesizeListeningBlock(makeBlockInput(), TEST_AZURE_CONFIG, client, 'B1');
  expect(mockState.closeCallCount).toBe(1);
});

it('case 33: close() is called on cancellation error', async () => {
  mockState.shouldCancel = true;
  mockState.cancellationRetryable = false;
  const { client } = makeSupabase();
  await expect(synthesizeListeningBlock(makeBlockInput(), TEST_AZURE_CONFIG, client, 'B1'))
    .rejects.toThrow();
  expect(mockState.closeCallCount).toBeGreaterThanOrEqual(1);
});

it('case 34: calculates duration from audioDuration ticks', async () => {
  // 3,000,000,000 ticks = 300,000 ms = 5 min
  const { client } = makeSupabase();
  const result = await synthesizeListeningBlock(makeBlockInput(), TEST_AZURE_CONFIG, client, 'B1');
  expect(result.durationMs).toBe(300_000);
});

it('case 35: audio hash is included in result', async () => {
  const { client } = makeSupabase();
  const result = await synthesizeListeningBlock(makeBlockInput(), TEST_AZURE_CONFIG, client, 'B1');
  expect(result.audioHash).toBeTruthy();
  expect(result.audioHash.length).toBe(32);
});

it('case 36: result is linked to ssmlHash', async () => {
  const { client } = makeSupabase();
  const result = await synthesizeListeningBlock(makeBlockInput({ ssmlHash: 'test-ssml-hash-val' }), TEST_AZURE_CONFIG, client, 'B1');
  expect(result.ssmlHash).toBe('test-ssml-hash-val');
});

it('case 37: staging path uses deterministic structure', async () => {
  const { client } = makeSupabase();
  const result = await synthesizeListeningBlock(makeBlockInput(), TEST_AZURE_CONFIG, client, 'B1');
  expect(result.audioPath).toContain('staging/');
  expect(result.audioPath).toContain('ep-1');
  expect(result.audioPath).toContain('block-01.mp3');
});

it('case 38: word timings are captured', async () => {
  const { client } = makeSupabase();
  const result = await synthesizeListeningBlock(makeBlockInput(), TEST_AZURE_CONFIG, client, 'B1');
  expect(result.wordTimingCount).toBeGreaterThan(0);
});

it('case 39: bookmark timings are persisted to DB', async () => {
  const { client, _insertCalls } = makeSupabase();
  await synthesizeListeningBlock(makeBlockInput(), TEST_AZURE_CONFIG, client, 'B1');
  const bmInsert = _insertCalls.find(c => c.table === 'listening_bookmark_timings');
  expect(bmInsert).toBeDefined();
});

it('case 40: word timings are persisted to DB', async () => {
  const { client, _insertCalls } = makeSupabase();
  await synthesizeListeningBlock(makeBlockInput(), TEST_AZURE_CONFIG, client, 'B1');
  const wdInsert = _insertCalls.find(c => c.table === 'listening_word_timings');
  expect(wdInsert).toBeDefined();
});

// ─── Episode orchestrator tests ──────────────────────────────────────────────

it('case 41: throws ListeningEpisodeNotFoundError when episode not found', async () => {
  const { client } = makeSupabase({ episode: null });
  await expect(synthesizeListeningEpisode({ episodeId: 'ep-missing' }, client, 'key', 'eastus'))
    .rejects.toThrow(ListeningEpisodeNotFoundError);
});

it('case 42: throws ListeningPublishedEpisodeImmutableError for published episode', async () => {
  const { client } = makeSupabase({ episode: { ...DEFAULT_EPISODE, status: 'published' } });
  await expect(synthesizeListeningEpisode({ episodeId: 'ep-1' }, client, 'key', 'eastus'))
    .rejects.toThrow(ListeningPublishedEpisodeImmutableError);
});

it('case 43: throws ListeningInvalidBlockStructureError with wrong block count', async () => {
  const { client } = makeSupabase({ blocks: [DEFAULT_BLOCKS[0]] });
  await expect(synthesizeListeningEpisode({ episodeId: 'ep-1' }, client, 'key', 'eastus'))
    .rejects.toThrow(ListeningInvalidBlockStructureError);
});

it('case 44: throws ListeningSsmlNotReadyError when ssml_status is not ready', async () => {
  const badBlocks = DEFAULT_BLOCKS.map(b => ({ ...b, ssml_status: 'pending' }));
  const { client } = makeSupabase({ blocks: badBlocks });
  await expect(synthesizeListeningEpisode({ episodeId: 'ep-1' }, client, 'key', 'eastus'))
    .rejects.toThrow(ListeningSsmlNotReadyError);
});

it('case 45: synthesizes both blocks and returns 2 results', async () => {
  mockState.bookmarkEvents = [
    { text: 'block-1-start', audioOffset: 100_000 },
    { text: 'b1s01', audioOffset: 500_000 },
    { text: 'block-1-end', audioOffset: 2_900_000_000 },
  ];
  const { client } = makeSupabase();
  const result = await synthesizeListeningEpisode({ episodeId: 'ep-1' }, client, 'key', 'eastus');
  expect(result.blocks).toHaveLength(2);
  expect(result.audioStatus).toBe('ready');
});

it('case 46: episode is marked processing before synthesis', async () => {
  const { client, _updateCalls } = makeSupabase();
  await synthesizeListeningEpisode({ episodeId: 'ep-1' }, client, 'key', 'eastus');
  const processingUpdate = _updateCalls.find(
    c => c.table === 'listening_episodes' && (c.data as Record<string, unknown>).audio_status === 'processing',
  );
  expect(processingUpdate).toBeDefined();
});

it('case 47: episode audio_status is set to ready after both blocks complete', async () => {
  const { client, _updateCalls } = makeSupabase();
  await synthesizeListeningEpisode({ episodeId: 'ep-1' }, client, 'key', 'eastus');
  const readyUpdate = _updateCalls.find(
    c => c.table === 'listening_episodes' && (c.data as Record<string, unknown>).audio_status === 'ready',
  );
  expect(readyUpdate).toBeDefined();
});

it('case 48: episode is NOT published after synthesis', async () => {
  const { client, _updateCalls } = makeSupabase();
  await synthesizeListeningEpisode({ episodeId: 'ep-1' }, client, 'key', 'eastus');
  const publishedUpdate = _updateCalls.find(
    c => c.table === 'listening_episodes' && (c.data as Record<string, unknown>).status === 'published',
  );
  expect(publishedUpdate).toBeUndefined();
});

it('case 49: validate-only mode does not call Azure and does not upload', async () => {
  const { client } = makeSupabase();
  vi.clearAllMocks();
  const result = await synthesizeListeningEpisode(
    { episodeId: 'ep-1', validateOnly: true },
    client, 'key', 'eastus',
  );
  expect(result.audioStatus).toBe('partial');
  // SpeechSynthesizer should not have been constructed
  const { SpeechSynthesizer } = await import('microsoft-cognitiveservices-speech-sdk');
  expect(SpeechSynthesizer).not.toHaveBeenCalled();
});

it('case 50: single-block filter synthesizes only that block', async () => {
  mockState.bookmarkEvents = [
    { text: 'block-1-start', audioOffset: 100_000 },
    { text: 'b1s01', audioOffset: 500_000 },
    { text: 'block-1-end', audioOffset: 2_900_000_000 },
  ];
  const { client } = makeSupabase();
  const result = await synthesizeListeningEpisode(
    { episodeId: 'ep-1', blockFilter: 1 },
    client, 'key', 'eastus',
  );
  expect(result.blocks).toHaveLength(1);
  expect(result.blocks[0].blockOrder).toBe(1);
});

it('case 51: credentials do not appear in result or thrown errors', async () => {
  const { client } = makeSupabase({ episode: null });
  try {
    await synthesizeListeningEpisode({ episodeId: 'ep-1' }, client, 'super-secret-key', 'eastus');
  } catch (err) {
    const errStr = JSON.stringify(err instanceof Error ? { name: err.name, message: err.message } : err);
    expect(errStr).not.toContain('super-secret-key');
  }
});

// ─── Group: AI Gateway integration (Etapa 9) — listening.episode_synthesize_audio ─

describe('synthesizeListeningBlock — AI Gateway (OBSERVE mode)', () => {
  beforeEach(() => {
    gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('a single successful synthesis records exactly one event: featureKey, provider, service, actorType system, userId undefined', async () => {
    const { client } = makeSupabase();
    await synthesizeListeningBlock(makeBlockInput(), TEST_AZURE_CONFIG, client, 'B1');
    expect(gw.mockStartEvent).toHaveBeenCalledTimes(1);
    expect(gw.mockStartEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        featureKey: 'listening.episode_synthesize_audio',
        provider: 'azure',
        service: 'tts_sdk',
        userId: undefined,
        actorType: 'system',
        executionLocation: 'system',
        attemptNumber: 1,
        callSequence: 1,
      }),
    );
    expect(gw.mockCompleteEvent).toHaveBeenCalledTimes(1);
  });

  it('records tts_characters from the SSML and a non-billable provider_requests', async () => {
    const { client } = makeSupabase();
    await synthesizeListeningBlock(makeBlockInput({ ssml: '<speak><voice name="x"><prosody rate="0%">Hello world</prosody></voice></speak>' }), TEST_AZURE_CONFIG, client, 'B1');
    const metrics = gw.mockInsertMetrics.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(metrics).toContainEqual(expect.objectContaining({ metricKey: 'provider_requests', quantity: 1, isBillable: false }));
    const ttsMetric = metrics.find((m) => m.metricKey === 'tts_characters');
    expect(ttsMetric?.isBillable).toBe(true);
    expect(ttsMetric?.quantity).toBeGreaterThan(0);
  });

  it('a non-retryable cancellation creates exactly one failed event (no retry attempted)', async () => {
    mockState.shouldCancel = true;
    mockState.cancellationRetryable = false; // AuthenticationFailure — non-retryable
    const { client } = makeSupabase();
    await expect(synthesizeListeningBlock(makeBlockInput(), TEST_AZURE_CONFIG, client, 'B1'))
      .rejects.toThrow(ListeningAzureSynthesisCanceledError);
    expect(gw.mockStartEvent).toHaveBeenCalledTimes(1);
    expect(gw.mockFailEvent).toHaveBeenCalledTimes(1);
    expect(gw.mockCompleteEvent).not.toHaveBeenCalled();
  });

  it('exhausting all retryable-cancellation attempts creates one failed event per physical attempt, sharing one correlationId with a globally increasing attemptNumber', async () => {
    vi.useFakeTimers();
    try {
      mockState.shouldCancel = true;
      mockState.cancellationRetryable = true; // ServiceError — retryable
      const { client } = makeSupabase();

      const promise = synthesizeListeningBlock(makeBlockInput(), TEST_AZURE_CONFIG, client, 'B1');
      // Rejections must be observed as soon as they occur, before advancing
      // timers further, to avoid an unhandled-rejection window.
      const assertion = expect(promise).rejects.toThrow(ListeningAzureSynthesisCanceledError);
      await vi.runAllTimersAsync();
      await assertion;

      // maxRetries=2 -> 3 physical attempts total, all cancelled (retryable
      // until the last one, which gives up because attempt >= maxRetries).
      expect(gw.mockStartEvent).toHaveBeenCalledTimes(3);
      expect(gw.mockFailEvent).toHaveBeenCalledTimes(3);
      expect(gw.mockCompleteEvent).not.toHaveBeenCalled();

      const calls = gw.mockStartEvent.mock.calls.map((c: any) => c[0]);
      expect(calls.map((c: any) => c.attemptNumber)).toEqual([1, 2, 3]);
      expect(new Set(calls.map((c: any) => c.correlationId)).size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('metadata contains no SSML/voice content — only allowlisted technical fields', async () => {
    const { client } = makeSupabase();
    await synthesizeListeningBlock(makeBlockInput({ ssml: '<speak><voice name="x">Very secret story content</voice></speak>' }), TEST_AZURE_CONFIG, client, 'B1');
    const startCall = gw.mockStartEvent.mock.calls[0][0] as any;
    const metadataStr = JSON.stringify(startCall.metadata);
    expect(metadataStr).not.toContain('secret story content');
  });

  it('a telemetry failure (startEvent) does not break synthesis', async () => {
    gw.mockStartEvent.mockRejectedValue(new Error('db down'));
    const { client } = makeSupabase();
    const result = await synthesizeListeningBlock(makeBlockInput(), TEST_AZURE_CONFIG, client, 'B1');
    expect(result.status).toBe('validated');
  });

  it('an idempotent cache hit (already-validated asset, file still in Storage) never calls the Speech SDK and never records a Gateway event', async () => {
    const audioPath = 'staging/B1/ep-1/v1/ssml-abc123ha/block-01.mp3';
    const existingAsset = {
      id: 'existing-asset', audio_path: audioPath, duration_ms: 5000,
      file_size_bytes: 12345, audio_hash: 'hash-1', word_timing_status: 'complete',
    };
    const chain: any = {};
    for (const m of ['select', 'eq']) chain[m] = vi.fn().mockReturnValue(chain);
    chain.maybeSingle = vi.fn().mockResolvedValue({ data: existingAsset, error: null });
    const client = {
      from: vi.fn(() => chain),
      storage: { from: vi.fn(() => ({ list: vi.fn().mockResolvedValue({ data: [{ name: audioPath.split('/').pop() }], error: null }) })) },
    } as any;

    const { SpeechSynthesizer } = await import('microsoft-cognitiveservices-speech-sdk');
    (SpeechSynthesizer as any).mockClear();
    const result = await synthesizeListeningBlock(makeBlockInput(), TEST_AZURE_CONFIG, client, 'B1');
    expect(result.status).toBe('validated');
    expect(SpeechSynthesizer).not.toHaveBeenCalled();
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
  });
});
