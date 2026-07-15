import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ListeningSentence } from '../../domain/listening/listening-types';
import type { ListeningSsmlConfig } from './listening-ssml-types';
import { DEFAULT_SSML_CONFIG, DEFAULT_PAUSE_CONFIG, SSML_GENERATOR_VERSION } from './listening-ssml-config';
import { buildListeningSsmlBlock } from './build-listening-ssml-block';
import { validateListeningSsmlStructure, ListeningSsmlStructureError } from './validate-listening-ssml';
import { validateListeningSsmlBookmarks } from './validate-listening-ssml-bookmarks';
import {
  computeSsmlContentHash,
  generateListeningSsml,
  ListeningSsmlEpisodeNotFoundError,
  ListeningSsmlPublishedError,
  ListeningSsmlInvalidBlockStructureError,
  ListeningSsmlMissingSentencesError,
} from './generate-listening-ssml';

// ─── Fixtures & helpers ────────────────────────────────────────────────────────

function makeSentence(overrides: Partial<ListeningSentence> = {}): ListeningSentence {
  return {
    id: 'snt-1',
    blockId: 'blk-1',
    sentenceKey: 'b1s01',
    sentenceOrder: 1,
    paragraphOrder: 1,
    speaker: null,
    textEn: 'Hello world.',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

interface MockBlockRow {
  id: string;
  block_order: number;
  ssml_status: string | null;
  ssml_generator_version: string | null;
  ssml_version: number | null;
  ssml_content_hash: string | null;
  ssml: string | null;
}

interface MockSentenceRow {
  id: string;
  block_id: string;
  sentence_key: string;
  sentence_order: number;
  paragraph_order: number;
  speaker: string | null;
  text_en: string;
  created_at: string;
}

interface MockEpisodeRow {
  id: string;
  status: string;
  voice_name: string | null;
  locale: string | null;
}

interface MockSupabaseOptions {
  episode?: MockEpisodeRow | null;
  blocks?: MockBlockRow[];
  sentences?: MockSentenceRow[];
  blockUpdateError?: string;
  episodeUpdateError?: string;
}

const DEFAULT_BLOCKS: MockBlockRow[] = [
  { id: 'blk-1', block_order: 1, ssml_status: null, ssml_generator_version: null, ssml_version: null, ssml_content_hash: null, ssml: null },
  { id: 'blk-2', block_order: 2, ssml_status: null, ssml_generator_version: null, ssml_version: null, ssml_content_hash: null, ssml: null },
];

const DEFAULT_SENTENCES: MockSentenceRow[] = [
  { id: 'snt-1', block_id: 'blk-1', sentence_key: 'b1s01', sentence_order: 1, paragraph_order: 1, speaker: null, text_en: 'Hello.', created_at: '2026-01-01T00:00:00Z' },
  { id: 'snt-2', block_id: 'blk-2', sentence_key: 'b2s01', sentence_order: 1, paragraph_order: 1, speaker: null, text_en: 'World.', created_at: '2026-01-01T00:00:00Z' },
];

function makeSupabase(opts: MockSupabaseOptions = {}) {
  const updateCalls: Array<{ table: string; data: unknown; id: unknown }> = [];

  const episode: MockEpisodeRow | null =
    opts.episode !== undefined
      ? opts.episode
      : { id: 'ep-1', status: 'content_ready', voice_name: null, locale: null };

  const blocks = opts.blocks ?? DEFAULT_BLOCKS;
  const sentences = opts.sentences ?? DEFAULT_SENTENCES;

  const from = vi.fn((table: string) => {
    if (table === 'listening_episodes') {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: episode,
              error: episode === null ? { message: 'Not found' } : null,
            }),
          }),
        }),
        update: (data: unknown) => ({
          eq: async (_col: string, id: unknown) => {
            updateCalls.push({ table, data, id });
            return { error: opts.episodeUpdateError ? { message: opts.episodeUpdateError } : null };
          },
        }),
      };
    }

    if (table === 'listening_blocks') {
      return {
        select: () => ({
          eq: () => ({
            order: async () => ({ data: blocks, error: null }),
          }),
        }),
        update: (data: unknown) => ({
          eq: async (_col: string, id: unknown) => {
            updateCalls.push({ table, data, id });
            return { error: opts.blockUpdateError ? { message: opts.blockUpdateError } : null };
          },
        }),
      };
    }

    if (table === 'listening_sentences') {
      return {
        select: () => ({
          in: () => ({
            order: async () => ({ data: sentences, error: null }),
          }),
        }),
      };
    }

    return {};
  });

  const client = { from } as unknown as SupabaseClient;
  return { client, _updateCalls: updateCalls };
}

// ─── Group 1: buildListeningSsmlBlock ─────────────────────────────────────────

describe('buildListeningSsmlBlock', () => {
  it('case 1: wraps single sentence in correct SSML structure', () => {
    const ssml = buildListeningSsmlBlock([makeSentence()], 1, DEFAULT_SSML_CONFIG);
    expect(ssml).toContain('<speak');
    expect(ssml).toContain('xml:lang="en-US"');
    expect(ssml).toContain('<voice name="en-US-AvaMultilingualNeural">');
    expect(ssml).toContain('<bookmark mark="block-1-start"/>');
    expect(ssml).toContain('<bookmark mark="b1s01"/>Hello world.');
    expect(ssml).toContain('<bookmark mark="block-1-end"/>');
    expect(ssml).toContain('</voice>');
    expect(ssml).toContain('</speak>');
  });

  it('case 2: does not insert break between sentences in same paragraph', () => {
    const sentences = [
      makeSentence({ sentenceKey: 'b1s01', sentenceOrder: 1, paragraphOrder: 1, textEn: 'First.' }),
      makeSentence({ id: 'snt-2', sentenceKey: 'b1s02', sentenceOrder: 2, paragraphOrder: 1, textEn: 'Second.' }),
    ];
    const ssml = buildListeningSsmlBlock(sentences, 1, DEFAULT_SSML_CONFIG);
    expect(ssml).not.toContain(`<break time="${DEFAULT_PAUSE_CONFIG.paragraphBreakMs}ms"/>`);
  });

  it('case 3: inserts paragraph break when paragraphOrder changes', () => {
    const sentences = [
      makeSentence({ sentenceKey: 'b1s01', sentenceOrder: 1, paragraphOrder: 1, textEn: 'First.' }),
      makeSentence({ id: 'snt-2', sentenceKey: 'b1s02', sentenceOrder: 2, paragraphOrder: 2, textEn: 'Second.' }),
    ];
    const ssml = buildListeningSsmlBlock(sentences, 1, DEFAULT_SSML_CONFIG);
    expect(ssml).toContain(`<break time="${DEFAULT_PAUSE_CONFIG.paragraphBreakMs}ms"/>`);
    const breakPos = ssml.indexOf('<break time="400ms"/>');
    const s2Pos = ssml.indexOf('<bookmark mark="b1s02"/>');
    expect(breakPos).toBeLessThan(s2Pos);
  });

  it('case 4: sorts sentences by sentenceOrder regardless of input order', () => {
    const sentences = [
      makeSentence({ id: 'snt-3', sentenceKey: 'b1s03', sentenceOrder: 3, textEn: 'Third.' }),
      makeSentence({ id: 'snt-1', sentenceKey: 'b1s01', sentenceOrder: 1, textEn: 'First.' }),
      makeSentence({ id: 'snt-2', sentenceKey: 'b1s02', sentenceOrder: 2, textEn: 'Second.' }),
    ];
    const ssml = buildListeningSsmlBlock(sentences, 1, DEFAULT_SSML_CONFIG);
    const pos1 = ssml.indexOf('b1s01');
    const pos2 = ssml.indexOf('b1s02');
    const pos3 = ssml.indexOf('b1s03');
    expect(pos1).toBeLessThan(pos2);
    expect(pos2).toBeLessThan(pos3);
  });

  it('case 5: includes prosody wrapper when config has prosody', () => {
    const ssml = buildListeningSsmlBlock([makeSentence()], 1, DEFAULT_SSML_CONFIG);
    expect(ssml).toContain('<prosody rate="-5%">');
    expect(ssml).toContain('</prosody>');
  });

  it('case 6: omits prosody wrapper when config.prosody is null', () => {
    const config: ListeningSsmlConfig = { ...DEFAULT_SSML_CONFIG, prosody: null };
    const ssml = buildListeningSsmlBlock([makeSentence()], 1, config);
    expect(ssml).not.toContain('<prosody');
    expect(ssml).not.toContain('</prosody>');
  });

  it('case 7: uses block-2-start and block-2-end for blockOrder 2', () => {
    const s = makeSentence({ blockId: 'blk-2', sentenceKey: 'b2s01' });
    const ssml = buildListeningSsmlBlock([s], 2, DEFAULT_SSML_CONFIG);
    expect(ssml).toContain('<bookmark mark="block-2-start"/>');
    expect(ssml).toContain('<bookmark mark="block-2-end"/>');
    expect(ssml).not.toContain('block-1-start');
    expect(ssml).not.toContain('block-1-end');
  });

  it('case 8: escapes XML special characters in sentence text', () => {
    const s = makeSentence({ textEn: 'A & B < C > D "E" \'F\'' });
    const ssml = buildListeningSsmlBlock([s], 1, DEFAULT_SSML_CONFIG);
    expect(ssml).toContain('A &amp; B &lt; C &gt; D &quot;E&quot; &apos;F&apos;');
  });

  it('case 9: applies pronunciation sub rule to sentence text', () => {
    const config: ListeningSsmlConfig = {
      ...DEFAULT_SSML_CONFIG,
      pronunciationRules: [{ sourceText: 'SQL', replacementType: 'sub', value: 'Sequel' }],
    };
    const ssml = buildListeningSsmlBlock([makeSentence({ textEn: 'I use SQL daily.' })], 1, config);
    expect(ssml).toContain('<sub alias="Sequel">SQL</sub>');
  });

  it('case 10: inserts blockStart break before block-start bookmark when blockStartMs > 0', () => {
    const config: ListeningSsmlConfig = {
      ...DEFAULT_SSML_CONFIG,
      pauses: { ...DEFAULT_PAUSE_CONFIG, blockStartMs: 500 },
    };
    const ssml = buildListeningSsmlBlock([makeSentence()], 1, config);
    expect(ssml).toContain('<break time="500ms"/>');
    const breakPos = ssml.indexOf('<break time="500ms"/>');
    const startPos = ssml.indexOf('<bookmark mark="block-1-start"/>');
    expect(breakPos).toBeLessThan(startPos);
  });
});

// ─── Group 2: validateListeningSsmlStructure ──────────────────────────────────

describe('validateListeningSsmlStructure', () => {
  const validSsml = [
    '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">',
    '  <voice name="en-US-AvaMultilingualNeural">',
    '    <bookmark mark="block-1-start"/>',
    '    <bookmark mark="b1s01"/>Hello.',
    '    <bookmark mark="block-1-end"/>',
    '  </voice>',
    '</speak>',
  ].join('\n');

  it('case 11: valid SSML passes without throwing', () => {
    expect(() => validateListeningSsmlStructure(validSsml, 1)).not.toThrow();
  });

  it('case 12: throws ListeningSsmlStructureError when not starting with <speak>', () => {
    expect(() => validateListeningSsmlStructure('<voice>bad</voice>', 1))
      .toThrow(ListeningSsmlStructureError);
  });

  it('case 13: throws ListeningSsmlStructureError when not ending with </speak>', () => {
    expect(() => validateListeningSsmlStructure('<speak><voice>no end', 1))
      .toThrow(ListeningSsmlStructureError);
  });

  it('case 14: throws when block-N-start bookmark is absent', () => {
    const ssml = validSsml.replace('<bookmark mark="block-1-start"/>', '');
    expect(() => validateListeningSsmlStructure(ssml, 1))
      .toThrow(ListeningSsmlStructureError);
  });

  it('case 15: throws when block-N-end bookmark is absent', () => {
    const ssml = validSsml.replace('<bookmark mark="block-1-end"/>', '');
    expect(() => validateListeningSsmlStructure(ssml, 1))
      .toThrow(ListeningSsmlStructureError);
  });
});

// ─── Group 3: validateListeningSsmlBookmarks ──────────────────────────────────

describe('validateListeningSsmlBookmarks', () => {
  function makeSsmlWithBookmarks(...marks: string[]): string {
    const bms = marks.map(m => `<bookmark mark="${m}"/>`).join('\n');
    return `<speak><voice>${bms}</voice></speak>`;
  }

  const twoSentences = [
    makeSentence({ sentenceKey: 'b1s01', sentenceOrder: 1 }),
    makeSentence({ id: 'snt-2', sentenceKey: 'b1s02', sentenceOrder: 2 }),
  ];

  it('case 16: returns valid=true when all bookmarks present in correct order', () => {
    const ssml = makeSsmlWithBookmarks('block-1-start', 'b1s01', 'b1s02', 'block-1-end');
    const result = validateListeningSsmlBookmarks(ssml, twoSentences, 1);
    expect(result.valid).toBe(true);
    expect(result.missing).toHaveLength(0);
    expect(result.duplicated).toHaveLength(0);
    expect(result.unexpected).toHaveLength(0);
    expect(result.outOfOrder).toHaveLength(0);
  });

  it('case 17: reports missing sentence bookmark', () => {
    const ssml = makeSsmlWithBookmarks('block-1-start', 'b1s01', 'block-1-end');
    const result = validateListeningSsmlBookmarks(ssml, twoSentences, 1);
    expect(result.valid).toBe(false);
    expect(result.missing).toContain('b1s02');
  });

  it('case 18: reports missing block-start bookmark', () => {
    const ssml = makeSsmlWithBookmarks('b1s01', 'b1s02', 'block-1-end');
    const result = validateListeningSsmlBookmarks(ssml, twoSentences, 1);
    expect(result.missing).toContain('block-1-start');
  });

  it('case 19: reports unexpected extra bookmark', () => {
    const ssml = makeSsmlWithBookmarks('block-1-start', 'b1s01', 'b1s02', 'extra-mark', 'block-1-end');
    const result = validateListeningSsmlBookmarks(ssml, twoSentences, 1);
    expect(result.valid).toBe(false);
    expect(result.unexpected).toContain('extra-mark');
  });

  it('case 20: reports duplicated bookmark', () => {
    const ssml = makeSsmlWithBookmarks('block-1-start', 'b1s01', 'b1s01', 'b1s02', 'block-1-end');
    const result = validateListeningSsmlBookmarks(ssml, twoSentences, 1);
    expect(result.valid).toBe(false);
    expect(result.duplicated).toContain('b1s01');
  });

  it('case 21: reports out-of-order bookmark when b1s02 appears before b1s01', () => {
    const ssml = makeSsmlWithBookmarks('block-1-start', 'b1s02', 'b1s01', 'block-1-end');
    const result = validateListeningSsmlBookmarks(ssml, twoSentences, 1);
    expect(result.valid).toBe(false);
    expect(result.outOfOrder.length).toBeGreaterThan(0);
  });

  it('case 22: with empty sentences only block start/end are expected and sufficient', () => {
    const ssml = makeSsmlWithBookmarks('block-1-start', 'block-1-end');
    const result = validateListeningSsmlBookmarks(ssml, [], 1);
    expect(result.valid).toBe(true);
    expect(result.expectedCount).toBe(2);
  });

  it('case 23: actualCount matches number of <bookmark> tags in SSML', () => {
    const ssml = makeSsmlWithBookmarks('block-1-start', 'b1s01', 'b1s02', 'block-1-end');
    const result = validateListeningSsmlBookmarks(ssml, twoSentences, 1);
    expect(result.actualCount).toBe(4);
    expect(result.expectedCount).toBe(4);
  });
});

// ─── Group 4: computeSsmlContentHash ─────────────────────────────────────────

describe('computeSsmlContentHash', () => {
  const baseSentences = [makeSentence()];

  it('case 24: same input produces same hash (deterministic)', () => {
    const h1 = computeSsmlContentHash(baseSentences, DEFAULT_SSML_CONFIG);
    const h2 = computeSsmlContentHash(baseSentences, DEFAULT_SSML_CONFIG);
    expect(h1).toBe(h2);
  });

  it('case 25: different sentence text produces different hash', () => {
    const other = [makeSentence({ textEn: 'Completely different sentence.' })];
    const h1 = computeSsmlContentHash(baseSentences, DEFAULT_SSML_CONFIG);
    const h2 = computeSsmlContentHash(other, DEFAULT_SSML_CONFIG);
    expect(h1).not.toBe(h2);
  });

  it('case 26: different voice config produces different hash', () => {
    const altConfig: ListeningSsmlConfig = {
      ...DEFAULT_SSML_CONFIG,
      voice: { locale: 'en-GB', voiceName: 'en-GB-SoniaNeural' },
    };
    const h1 = computeSsmlContentHash(baseSentences, DEFAULT_SSML_CONFIG);
    const h2 = computeSsmlContentHash(baseSentences, altConfig);
    expect(h1).not.toBe(h2);
  });

  it('case 27: unsorted input produces same hash as sorted (order-independent)', () => {
    const unsorted = [
      makeSentence({ id: 'snt-3', sentenceKey: 'b1s03', sentenceOrder: 3, textEn: 'Third.' }),
      makeSentence({ id: 'snt-1', sentenceKey: 'b1s01', sentenceOrder: 1, textEn: 'First.' }),
      makeSentence({ id: 'snt-2', sentenceKey: 'b1s02', sentenceOrder: 2, textEn: 'Second.' }),
    ];
    const sorted = [...unsorted].sort((a, b) => a.sentenceOrder - b.sentenceOrder);
    expect(computeSsmlContentHash(unsorted, DEFAULT_SSML_CONFIG)).toBe(
      computeSsmlContentHash(sorted, DEFAULT_SSML_CONFIG),
    );
  });
});

// ─── Group 5: generateListeningSsml ───────────────────────────────────────────

describe('generateListeningSsml', () => {
  it('case 28: dryRun returns valid SSML result without persisting blocks', async () => {
    const { client, _updateCalls } = makeSupabase();
    const result = await generateListeningSsml({ episodeId: 'ep-1', dryRun: true }, client);
    expect(result.status).toBe('ready');
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0].ssml).toContain('<speak');
    expect(result.blocks[1].ssml).toContain('<speak');
    const blockUpdates = _updateCalls.filter(c => c.table === 'listening_blocks');
    expect(blockUpdates).toHaveLength(0);
  });

  it('case 29: throws ListeningSsmlEpisodeNotFoundError when episode not found', async () => {
    const { client } = makeSupabase({ episode: null });
    await expect(generateListeningSsml({ episodeId: 'ep-missing' }, client)).rejects.toThrow(
      ListeningSsmlEpisodeNotFoundError,
    );
  });

  it('case 30: throws ListeningSsmlPublishedError for published episode', async () => {
    const { client } = makeSupabase({
      episode: { id: 'ep-1', status: 'published', voice_name: null, locale: null },
    });
    await expect(generateListeningSsml({ episodeId: 'ep-1' }, client)).rejects.toThrow(
      ListeningSsmlPublishedError,
    );
  });

  it('case 31: throws ListeningSsmlInvalidBlockStructureError when block count is not 2', async () => {
    const { client } = makeSupabase({ blocks: [DEFAULT_BLOCKS[0]] });
    await expect(generateListeningSsml({ episodeId: 'ep-1' }, client)).rejects.toThrow(
      ListeningSsmlInvalidBlockStructureError,
    );
  });

  it('case 32: throws ListeningSsmlMissingSentencesError when block has no sentences', async () => {
    const { client } = makeSupabase({ sentences: [] });
    await expect(generateListeningSsml({ episodeId: 'ep-1' }, client)).rejects.toThrow(
      ListeningSsmlMissingSentencesError,
    );
  });

  it('case 33: returns idempotent result when both blocks are ready at current generator version', async () => {
    const readyBlocks: MockBlockRow[] = [
      { id: 'blk-1', block_order: 1, ssml_status: 'ready', ssml_generator_version: SSML_GENERATOR_VERSION, ssml_version: 3, ssml_content_hash: 'abc123', ssml: '<speak>existing-block1</speak>' },
      { id: 'blk-2', block_order: 2, ssml_status: 'ready', ssml_generator_version: SSML_GENERATOR_VERSION, ssml_version: 3, ssml_content_hash: 'def456', ssml: '<speak>existing-block2</speak>' },
    ];
    const { client, _updateCalls } = makeSupabase({ blocks: readyBlocks });
    const result = await generateListeningSsml({ episodeId: 'ep-1' }, client);
    expect(result.status).toBe('ready');
    expect(_updateCalls).toHaveLength(0);
    expect(result.blocks[0].ssml).toBe('<speak>existing-block1</speak>');
    expect(result.blocks[1].ssml).toBe('<speak>existing-block2</speak>');
  });

  it('case 34: forceRegeneration=true bypasses idempotency and regenerates', async () => {
    const readyBlocks: MockBlockRow[] = [
      { id: 'blk-1', block_order: 1, ssml_status: 'ready', ssml_generator_version: SSML_GENERATOR_VERSION, ssml_version: 1, ssml_content_hash: 'old', ssml: '<speak>old-block1</speak>' },
      { id: 'blk-2', block_order: 2, ssml_status: 'ready', ssml_generator_version: SSML_GENERATOR_VERSION, ssml_version: 1, ssml_content_hash: 'old', ssml: '<speak>old-block2</speak>' },
    ];
    const { client, _updateCalls } = makeSupabase({ blocks: readyBlocks });
    const result = await generateListeningSsml({ episodeId: 'ep-1', forceRegeneration: true }, client);
    expect(result.status).toBe('ready');
    const blockUpdates = _updateCalls.filter(c => c.table === 'listening_blocks');
    expect(blockUpdates).toHaveLength(2);
    expect(result.blocks[0].ssml).not.toBe('<speak>old-block1</speak>');
  });

  it('case 35: marks episode as processing before generating SSML', async () => {
    const { client, _updateCalls } = makeSupabase();
    await generateListeningSsml({ episodeId: 'ep-1' }, client);
    const processingUpdate = _updateCalls.find(
      c => c.table === 'listening_episodes' && (c.data as Record<string, unknown>).ssml_status === 'processing',
    );
    expect(processingUpdate).toBeDefined();
  });

  it('case 36: persists SSML to both blocks with status=ready', async () => {
    const { client, _updateCalls } = makeSupabase();
    await generateListeningSsml({ episodeId: 'ep-1' }, client);
    const blockUpdates = _updateCalls.filter(c => c.table === 'listening_blocks');
    expect(blockUpdates).toHaveLength(2);
    const updatedIds = blockUpdates.map(u => u.id as string).sort();
    expect(updatedIds).toEqual(['blk-1', 'blk-2']);
    for (const update of blockUpdates) {
      const data = update.data as Record<string, unknown>;
      expect(data.ssml_status).toBe('ready');
      expect(typeof data.ssml).toBe('string');
      expect(data.ssml as string).toContain('<speak');
    }
  });

  it('case 37: updates episode status to ready after persisting blocks', async () => {
    const { client, _updateCalls } = makeSupabase();
    await generateListeningSsml({ episodeId: 'ep-1' }, client);
    const readyUpdate = _updateCalls.find(
      c => c.table === 'listening_episodes' && (c.data as Record<string, unknown>).ssml_status === 'ready',
    );
    expect(readyUpdate).toBeDefined();
  });

  it('case 38: dryRun=true with supabase generates SSML but does not write to blocks', async () => {
    const { client, _updateCalls } = makeSupabase();
    const result = await generateListeningSsml({ episodeId: 'ep-1', dryRun: true }, client);
    expect(result.status).toBe('ready');
    const blockUpdates = _updateCalls.filter(c => c.table === 'listening_blocks');
    expect(blockUpdates).toHaveLength(0);
  });

  it('case 39: result blocks have blockOrder values 1 and 2', async () => {
    const { client } = makeSupabase();
    const result = await generateListeningSsml({ episodeId: 'ep-1' }, client);
    const orders = result.blocks.map(b => b.blockOrder).sort((a, b) => a - b);
    expect(orders).toEqual([1, 2]);
  });

  it('case 40: sentenceCount in result matches actual sentence count per block', async () => {
    const sentences: MockSentenceRow[] = [
      { id: 'snt-1', block_id: 'blk-1', sentence_key: 'b1s01', sentence_order: 1, paragraph_order: 1, speaker: null, text_en: 'First.', created_at: '2026-01-01T00:00:00Z' },
      { id: 'snt-2', block_id: 'blk-1', sentence_key: 'b1s02', sentence_order: 2, paragraph_order: 1, speaker: null, text_en: 'Second.', created_at: '2026-01-01T00:00:00Z' },
      { id: 'snt-3', block_id: 'blk-2', sentence_key: 'b2s01', sentence_order: 1, paragraph_order: 1, speaker: null, text_en: 'Third.', created_at: '2026-01-01T00:00:00Z' },
    ];
    const { client } = makeSupabase({ sentences });
    const result = await generateListeningSsml({ episodeId: 'ep-1' }, client);
    const block1 = result.blocks.find(b => b.blockOrder === 1)!;
    const block2 = result.blocks.find(b => b.blockOrder === 2)!;
    expect(block1.sentenceCount).toBe(2);
    expect(block2.sentenceCount).toBe(1);
  });
});
