import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  toPublicListeningQuestion,
  buildPublicListeningEpisode,
} from './build-public-listening-episode';
import { validateListeningEpisodeForPublication } from './validate-listening-publication';
import { canUserAccessListeningEpisode } from './authorize-listening-access';
import {
  LISTENING_ERRORS,
  ListeningPublicationError,
} from './listening-publication-types';
import { buildPublishedPath, buildStagingPath } from './listening-publication-config';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('./_supabase', () => ({
  getListeningServiceClient: vi.fn(() => mockServiceClient),
}));

vi.mock('./create-listening-signed-url', () => ({
  createListeningAudioSignedUrl: vi.fn(async () => ({
    blockId: 'block-1',
    blockOrder: 1 as const,
    url: 'https://storage.example.com/signed/block-01.mp3?token=abc',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    durationMs: 120000,
    contentType: 'audio/mpeg',
  })),
}));

// ─── Mock Supabase clients ────────────────────────────────────────────────────

type MockClient = { from: (table: string) => any; storage: any };

let mockServiceClient: MockClient;
let mockAuthedClient: MockClient;

function buildMockClients(overrides: {
  episodes?: unknown[];
  blocks?: unknown[];
  questions?: unknown[];
  questions_public?: unknown[];
  subtitle_cues?: unknown[];
  audio_assets?: unknown[];
  publication_log?: unknown[];
  storageListResult?: unknown[];
  storageListError?: { message: string } | null;
  storageCopyError?: { message: string } | null;
  storageSignedUrlError?: { message: string } | null;
} = {}) {
  const tableRows: Record<string, unknown[]> = {
    listening_episodes: overrides.episodes ?? [],
    listening_blocks: overrides.blocks ?? [],
    listening_questions: overrides.questions ?? [],
    listening_questions_public: overrides.questions_public ?? [],
    listening_subtitle_cues: overrides.subtitle_cues ?? [],
    listening_audio_assets: overrides.audio_assets ?? [],
    listening_publication_log: overrides.publication_log ?? [],
  };

  // storageListResult: [] → file not found; [{metadata:{size:0}}] → empty file; default → 1024B file
  const listResultTemplate = overrides.storageListResult ?? [{ metadata: { size: 1024 } }];
  const listError = overrides.storageListError ?? null;
  const copyError = overrides.storageCopyError ?? null;
  const signedError = overrides.storageSignedUrlError ?? null;

  const storage = {
    from: (_bucket: string) => ({
      // Returns a file matching the searched filename so both block-01 and block-02 are found.
      list: async (_folder: string, opts?: { search?: string }) => {
        if (listError) return { data: null, error: listError };
        if (listResultTemplate.length === 0) return { data: [], error: null };
        const name = opts?.search ?? 'file.mp3';
        const tmpl = listResultTemplate[0] as any;
        return { data: [{ name, metadata: tmpl.metadata }], error: null };
      },
      copy: async () => ({ error: copyError }),
      remove: async () => ({ error: null }),
      createSignedUrl: async () => ({
        data: signedError ? null : { signedUrl: 'https://signed.url/audio.mp3' },
        error: signedError,
      }),
    }),
  };

  const fromFn = (table: string) => {
    const rows = tableRows[table] ?? [];
    // A thenable builder: awaiting it resolves to { data: rows, error: null }
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      neq: () => builder,
      in: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      single: async () => ({ data: rows[0] ?? null, error: null }),
      insert: (_data: unknown) => ({
        select: () => ({ single: async () => ({ data: { id: 'log-id' }, error: null }) }),
      }),
      update: () => builder,
      then: (resolve: any, reject: any) =>
        Promise.resolve({ data: rows, error: null }).then(resolve, reject),
    };
    return builder;
  };

  mockServiceClient = { from: fromFn as any, storage };
  mockAuthedClient = { from: fromFn as any, storage };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const EP_ID = 'ep000000-0000-0000-0000-000000000001';
const B1_ID = 'b1000000-0000-0000-0000-000000000001';
const B2_ID = 'b1000000-0000-0000-0000-000000000002';
const Q1_ID = 'q1000000-0000-0000-0000-000000000001';
const Q2_ID = 'q1000000-0000-0000-0000-000000000002';
const A1_ID = 'a1000000-0000-0000-0000-000000000001';
const A2_ID = 'a1000000-0000-0000-0000-000000000002';

const SSML_HASH_1 = 'ssmlhash1';
const SSML_HASH_2 = 'ssmlhash2';
const AUDIO_HASH_1 = 'audiohash1';
const AUDIO_HASH_2 = 'audiohash2';
const TIMING_HASH_1 = 'timinghash1';
const TIMING_HASH_2 = 'timinghash2';

const STAGING_PATH_1 = `staging/B1/${EP_ID}/v1/${SSML_HASH_1}/block-01.mp3`;
const STAGING_PATH_2 = `staging/B1/${EP_ID}/v1/${SSML_HASH_2}/block-02.mp3`;

function makeEpisode(overrides: Record<string, unknown> = {}) {
  return {
    id: EP_ID,
    title: 'Test Episode',
    synopsis: null,
    cefr_level: 'B1',
    status: 'ready',
    content_version: 1,
    estimated_duration_seconds: 600,
    actual_duration_seconds: 590,
    published_at: null,
    publication_version: 0,
    access_tier: 'free',
    ...overrides,
  };
}

function makeBlock(order: 1 | 2, overrides: Record<string, unknown> = {}) {
  return {
    id: order === 1 ? B1_ID : B2_ID,
    episode_id: EP_ID,
    block_order: order,
    status: 'ready',
    ssml: '<speak>test</speak>',
    ssml_content_hash: order === 1 ? SSML_HASH_1 : SSML_HASH_2,
    audio_path: null,
    duration_ms: 295000,
    ...overrides,
  };
}

function makeQuestion(order: 1 | 2, overrides: Record<string, unknown> = {}) {
  return {
    id: order === 1 ? Q1_ID : Q2_ID,
    episode_id: EP_ID,
    block_id: order === 1 ? B1_ID : B2_ID,
    question_order: order,
    prompt: `Question ${order}`,
    options_json: ['A', 'B', 'C', 'D'],
    validation_status: 'valid',
    max_attempts: 3,
    ...overrides,
  };
}

function makeCue(blockId: string, lang: 'en' | 'pt-BR', order: number) {
  return {
    id: `cue-${blockId}-${lang}-${order}`,
    block_id: blockId,
    language: lang,
    cue_order: order,
    start_ms: (order - 1) * 3000,
    end_ms: order * 3000,
    text: `Cue ${order}`,
    sentence_key: `key-${order}`,
  };
}

function makeAsset(blockId: string, order: 1 | 2, overrides: Record<string, unknown> = {}) {
  const ssmlHash = order === 1 ? SSML_HASH_1 : SSML_HASH_2;
  const audioHash = order === 1 ? AUDIO_HASH_1 : AUDIO_HASH_2;
  const timingHash = order === 1 ? TIMING_HASH_1 : TIMING_HASH_2;
  return {
    id: order === 1 ? A1_ID : A2_ID,
    episode_id: EP_ID,
    block_id: blockId,
    ssml_hash: ssmlHash,
    audio_hash: audioHash,
    // audio_path is the real column synthesis writes (persist-listening-audio.ts) —
    // it plays the "staging" role validation/publication copy from.
    audio_path: order === 1 ? STAGING_PATH_1 : STAGING_PATH_2,
    published_path: null,
    file_size_bytes: 1024,
    duration_ms: 295000,
    content_type: 'audio/mpeg',
    // 'validated' is the status persist-listening-audio.ts actually sets on
    // successful synthesis — not 'ready' (that value is never written).
    status: 'validated',
    // timing_hash is written directly onto the asset by
    // persist-listening-timings.ts — there is no separate timing-artifact row.
    timing_hash: timingHash,
    ...overrides,
  };
}

function fullValidMockData() {
  return {
    episodes: [makeEpisode()],
    blocks: [makeBlock(1), makeBlock(2)],
    questions: [makeQuestion(1), makeQuestion(2)],
    subtitle_cues: [
      makeCue(B1_ID, 'en', 1), makeCue(B1_ID, 'en', 2),
      makeCue(B1_ID, 'pt-BR', 1), makeCue(B1_ID, 'pt-BR', 2),
      makeCue(B2_ID, 'en', 1), makeCue(B2_ID, 'en', 2),
      makeCue(B2_ID, 'pt-BR', 1), makeCue(B2_ID, 'pt-BR', 2),
    ],
    audio_assets: [makeAsset(B1_ID, 1), makeAsset(B2_ID, 2)],
  };
}

// ─── Grupo 1: toPublicListeningQuestion ───────────────────────────────────────

describe('toPublicListeningQuestion', () => {
  it('retorna pergunta pública sem correctOption', () => {
    const q = {
      id: Q1_ID,
      question_order: 1,
      block_id: B1_ID,
      prompt: 'Test?',
      options_json: ['A', 'B', 'C', 'D'],
      correct_option: 1,
      max_attempts: 3,
    };
    const pub = toPublicListeningQuestion(q as any);
    expect(pub).not.toHaveProperty('correctOption');
    expect(pub).not.toHaveProperty('correct_option');
    expect(pub).not.toHaveProperty('explanationPt');
    expect(pub).not.toHaveProperty('explanation_pt');
    expect(pub.options).toEqual(['A', 'B', 'C', 'D']);
    expect(pub.maxAttempts).toBe(3);
  });

  it('não retorna explicação', () => {
    const q = {
      id: Q1_ID,
      question_order: 1,
      block_id: B1_ID,
      prompt: 'Test?',
      options_json: ['A', 'B'],
      explanation_pt: 'Resposta correta é B.',
      max_attempts: 3,
    };
    const pub = toPublicListeningQuestion(q as any);
    expect(JSON.stringify(pub)).not.toContain('Resposta correta');
    expect(JSON.stringify(pub)).not.toContain('explanation');
  });

  it('usa options (não optionsJson)', () => {
    const q = { id: Q1_ID, question_order: 1, block_id: B1_ID, prompt: 'Q', options_json: ['X'], max_attempts: 3 };
    const pub = toPublicListeningQuestion(q as any);
    expect(pub).toHaveProperty('options');
    expect(pub).not.toHaveProperty('optionsJson');
    expect(pub).not.toHaveProperty('options_json');
  });
});

// ─── Grupo 2: validateListeningEpisodeForPublication ─────────────────────────

describe('validateListeningEpisodeForPublication', () => {
  beforeEach(() => {
    buildMockClients(fullValidMockData());
  });

  it('valida episódio completo', async () => {
    buildMockClients(fullValidMockData());
    const result = await validateListeningEpisodeForPublication(EP_ID);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejeita episódio não encontrado', async () => {
    buildMockClients({ episodes: [] });
    const result = await validateListeningEpisodeForPublication(EP_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'EPISODE_NOT_FOUND')).toBe(true);
  });

  it('rejeita episódio arquivado', async () => {
    buildMockClients({ ...fullValidMockData(), episodes: [makeEpisode({ status: 'archived' })] });
    const result = await validateListeningEpisodeForPublication(EP_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'EPISODE_ARCHIVED')).toBe(true);
  });

  it('rejeita episódio já publicado', async () => {
    buildMockClients({ ...fullValidMockData(), episodes: [makeEpisode({ status: 'published', published_at: new Date().toISOString() })] });
    const result = await validateListeningEpisodeForPublication(EP_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'EPISODE_ALREADY_PUBLISHED')).toBe(true);
  });

  it('rejeita episódio com apenas um bloco', async () => {
    buildMockClients({ ...fullValidMockData(), blocks: [makeBlock(1)] });
    const result = await validateListeningEpisodeForPublication(EP_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'WRONG_BLOCK_COUNT')).toBe(true);
  });

  it('rejeita episódio sem pergunta', async () => {
    buildMockClients({ ...fullValidMockData(), questions: [] });
    const result = await validateListeningEpisodeForPublication(EP_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'WRONG_QUESTION_COUNT')).toBe(true);
  });

  it('rejeita pergunta com validation_status != valid', async () => {
    buildMockClients({
      ...fullValidMockData(),
      questions: [makeQuestion(1, { validation_status: 'failed' }), makeQuestion(2)],
    });
    const result = await validateListeningEpisodeForPublication(EP_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'QUESTION_NOT_VALID')).toBe(true);
  });

  it('rejeita legenda en ausente', async () => {
    const cues = fullValidMockData().subtitle_cues.filter(
      (c) => !(c.block_id === B1_ID && c.language === 'en'),
    );
    buildMockClients({ ...fullValidMockData(), subtitle_cues: cues });
    const result = await validateListeningEpisodeForPublication(EP_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'SUBTITLES_EN_MISSING')).toBe(true);
  });

  it('rejeita legenda pt-BR ausente', async () => {
    const cues = fullValidMockData().subtitle_cues.filter(
      (c) => !(c.block_id === B1_ID && c.language === 'pt-BR'),
    );
    buildMockClients({ ...fullValidMockData(), subtitle_cues: cues });
    const result = await validateListeningEpisodeForPublication(EP_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'SUBTITLES_PT_MISSING')).toBe(true);
  });

  it('rejeita SSML ausente', async () => {
    buildMockClients({
      ...fullValidMockData(),
      blocks: [makeBlock(1, { ssml: null }), makeBlock(2)],
    });
    const result = await validateListeningEpisodeForPublication(EP_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'SSML_MISSING')).toBe(true);
  });

  it('rejeita áudio ausente (sem asset)', async () => {
    buildMockClients({ ...fullValidMockData(), audio_assets: [makeAsset(B2_ID, 2)] });
    const result = await validateListeningEpisodeForPublication(EP_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'AUDIO_ASSET_MISSING')).toBe(true);
  });

  it('rejeita timing ausente (asset sem timing_hash — persist-listening-timings.ts nunca rodou)', async () => {
    buildMockClients({
      ...fullValidMockData(),
      audio_assets: [makeAsset(B1_ID, 1), makeAsset(B2_ID, 2, { timing_hash: null })],
    });
    const result = await validateListeningEpisodeForPublication(EP_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'TIMING_MISSING')).toBe(true);
  });

  it('rejeita hash divergente (bloco.ssml_content_hash != audio_asset.ssml_hash)', async () => {
    buildMockClients({
      ...fullValidMockData(),
      blocks: [makeBlock(1, { ssml_content_hash: 'DIFFERENT_HASH' }), makeBlock(2)],
    });
    const result = await validateListeningEpisodeForPublication(EP_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'HASH_MISMATCH_SSML_BLOCK_ASSET')).toBe(true);
  });

  it('rejeita audio asset com status != validated/published', async () => {
    buildMockClients({
      ...fullValidMockData(),
      audio_assets: [makeAsset(B1_ID, 1), makeAsset(B2_ID, 2, { status: 'uploaded' })],
    });
    const result = await validateListeningEpisodeForPublication(EP_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'AUDIO_ASSET_NOT_READY')).toBe(true);
  });

  it('rejeita arquivo de staging vazio', async () => {
    buildMockClients({
      ...fullValidMockData(),
      storageListResult: [{ name: 'block-01.mp3', metadata: { size: 0 } }],
    });
    const result = await validateListeningEpisodeForPublication(EP_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'STORAGE_FILE_EMPTY')).toBe(true);
  });

  it('rejeita arquivo de staging inexistente', async () => {
    buildMockClients({ ...fullValidMockData(), storageListResult: [] });
    const result = await validateListeningEpisodeForPublication(EP_ID);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'STORAGE_FILE_NOT_FOUND')).toBe(true);
  });
});

// ─── Grupo 3: buildPublishedPath / buildStagingPath ───────────────────────────

describe('buildPublishedPath', () => {
  it('usa path determinístico sem título da história', () => {
    const path = buildPublishedPath('B1', EP_ID, 1, AUDIO_HASH_1, 1);
    expect(path).toBe(`published/B1/${EP_ID}/v1/${AUDIO_HASH_1}/block-01.mp3`);
    expect(path).not.toContain('title');
    expect(path).not.toContain('story');
  });

  it('paths para versões diferentes são diferentes', () => {
    const v1 = buildPublishedPath('A2', EP_ID, 1, AUDIO_HASH_1, 1);
    const v2 = buildPublishedPath('A2', EP_ID, 2, AUDIO_HASH_1, 1);
    expect(v1).not.toBe(v2);
  });

  it('paths para blocos diferentes são diferentes', () => {
    const b1 = buildPublishedPath('A2', EP_ID, 1, AUDIO_HASH_1, 1);
    const b2 = buildPublishedPath('A2', EP_ID, 1, AUDIO_HASH_1, 2);
    expect(b1).not.toBe(b2);
    expect(b1).toContain('block-01');
    expect(b2).toContain('block-02');
  });

  it('path publicado nunca é igual ao path de staging', () => {
    const pub = buildPublishedPath('B1', EP_ID, 1, AUDIO_HASH_1, 1);
    const stg = buildStagingPath('B1', EP_ID, 1, SSML_HASH_1, 1);
    expect(pub).not.toBe(stg);
    expect(pub).toContain('published/');
    expect(stg).toContain('staging/');
  });
});

// ─── Grupo 4: canUserAccessListeningEpisode ───────────────────────────────────

describe('canUserAccessListeningEpisode', () => {
  it('nega acesso sem userId', async () => {
    buildMockClients({ episodes: [makeEpisode({ status: 'published', published_at: '2026-07-15T00:00:00Z' })] });
    const result = await canUserAccessListeningEpisode(mockAuthedClient as any, { userId: '', episodeId: EP_ID });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('unauthenticated');
  });

  it('nega acesso a episódio não publicado', async () => {
    buildMockClients({ episodes: [] }); // episódio not found → maybeSingle retorna null
    const result = await canUserAccessListeningEpisode(mockAuthedClient as any, { userId: 'user-1', episodeId: EP_ID });
    expect(result.allowed).toBe(false);
  });

  it('nega acesso a episódio arquivado', async () => {
    buildMockClients({ episodes: [makeEpisode({ status: 'archived' })] });
    const result = await canUserAccessListeningEpisode(mockAuthedClient as any, { userId: 'user-1', episodeId: EP_ID });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('episode_archived');
  });

  it('permite acesso a episódio publicado', async () => {
    buildMockClients({
      episodes: [makeEpisode({ status: 'published', published_at: new Date().toISOString() })],
    });
    const result = await canUserAccessListeningEpisode(mockAuthedClient as any, { userId: 'user-1', episodeId: EP_ID });
    expect(result.allowed).toBe(true);
  });
});

// ─── Grupo 5: buildPublicListeningEpisode — vazamento de dados ───────────────

describe('buildPublicListeningEpisode — sem vazamento de dados privados', () => {
  beforeEach(() => {
    buildMockClients({
      episodes: [makeEpisode({ status: 'published', published_at: new Date().toISOString() })],
      blocks: [makeBlock(1), makeBlock(2)],
      questions_public: [
        { id: Q1_ID, question_order: 1, block_id: B1_ID, prompt: 'Q1?', options_json: ['A', 'B', 'C', 'D'], max_attempts: 3 },
        { id: Q2_ID, question_order: 2, block_id: B2_ID, prompt: 'Q2?', options_json: ['A', 'B', 'C', 'D'], max_attempts: 3 },
      ],
      subtitle_cues: [
        makeCue(B1_ID, 'en', 1), makeCue(B1_ID, 'pt-BR', 1),
        makeCue(B2_ID, 'en', 1), makeCue(B2_ID, 'pt-BR', 1),
      ],
    });
  });

  it('retorna dois blocos', async () => {
    const response = await buildPublicListeningEpisode(EP_ID, 'user-1', mockAuthedClient as any);
    expect(response.blocks).toHaveLength(2);
  });

  it('não retorna correctOption nem explicação', async () => {
    const response = await buildPublicListeningEpisode(EP_ID, 'user-1', mockAuthedClient as any);
    const json = JSON.stringify(response);
    expect(json).not.toContain('correctOption');
    expect(json).not.toContain('correct_option');
    expect(json).not.toContain('explanationPt');
    expect(json).not.toContain('explanation_pt');
  });

  it('não retorna SSML', async () => {
    const response = await buildPublicListeningEpisode(EP_ID, 'user-1', mockAuthedClient as any);
    const json = JSON.stringify(response);
    expect(json).not.toContain('<speak>');
    expect(json).not.toContain('ssml');
  });

  it('não retorna hashes internos', async () => {
    const response = await buildPublicListeningEpisode(EP_ID, 'user-1', mockAuthedClient as any);
    const json = JSON.stringify(response);
    expect(json).not.toContain('audio_hash');
    expect(json).not.toContain('ssml_hash');
    expect(json).not.toContain('timing_hash');
    expect(json).not.toContain('ssml_content_hash');
  });

  it('não retorna paths privados de staging', async () => {
    const response = await buildPublicListeningEpisode(EP_ID, 'user-1', mockAuthedClient as any);
    const json = JSON.stringify(response);
    expect(json).not.toContain('staging/');
    expect(json).not.toContain('staging_path');
    expect(json).not.toContain('published_path');
  });

  it('não retorna sentence_key como campo interno', async () => {
    const response = await buildPublicListeningEpisode(EP_ID, 'user-1', mockAuthedClient as any);
    const json = JSON.stringify(response);
    expect(json).not.toContain('sentence_key');
    expect(json).not.toContain('audio_hash');
  });

  it('retorna legendas ordenadas com cueKey', async () => {
    const response = await buildPublicListeningEpisode(EP_ID, 'user-1', mockAuthedClient as any);
    const block1 = response.blocks[0];
    expect(block1.subtitles?.en[0]).toHaveProperty('cueKey');
    expect(block1.subtitles?.en[0]).toHaveProperty('startMs');
    expect(block1.subtitles?.en[0]).toHaveProperty('endMs');
    expect(block1.subtitles?.en[0]).toHaveProperty('text');
    expect(block1.subtitles?.en[0]).not.toHaveProperty('sentence_key');
    expect(block1.subtitles?.en[0]).not.toHaveProperty('id');
    expect(block1.subtitles?.en[0]).not.toHaveProperty('block_id');
  });

  it('bloco 2 tem locked=true (sem progresso implementado)', async () => {
    const response = await buildPublicListeningEpisode(EP_ID, 'user-1', mockAuthedClient as any);
    expect(response.blocks[0].blockOrder).toBe(1);
    expect(response.blocks[0].locked).toBe(false);
    expect(response.blocks[1].blockOrder).toBe(2);
    expect(response.blocks[1].locked).toBe(true);
  });

  it('retorna URL assinada com expiresAt', async () => {
    const response = await buildPublicListeningEpisode(EP_ID, 'user-1', mockAuthedClient as any);
    const audio = response.blocks[0].audio;
    expect(audio).not.toBeNull();
    expect(audio?.url).toBeDefined();
    expect(audio?.expiresAt).toBeDefined();
  });

  it('não retorna eventos brutos de timing', async () => {
    const response = await buildPublicListeningEpisode(EP_ID, 'user-1', mockAuthedClient as any);
    const json = JSON.stringify(response);
    expect(json).not.toContain('word_events');
    expect(json).not.toContain('bookmarks');
    expect(json).not.toContain('raw_events');
    expect(json).not.toContain('source_sentence_keys');
  });

  it('pergunta pública tem options (não optionsJson)', async () => {
    const response = await buildPublicListeningEpisode(EP_ID, 'user-1', mockAuthedClient as any);
    const q = response.blocks[0].question;
    expect(q).toHaveProperty('options');
    expect(q).not.toHaveProperty('optionsJson');
    expect(q).not.toHaveProperty('options_json');
  });
});

// ─── Grupo 6: LISTENING_ERRORS — códigos tipados ──────────────────────────────

describe('LISTENING_ERRORS', () => {
  it('todos os códigos são strings únicas', () => {
    const values = Object.values(LISTENING_ERRORS);
    expect(values.length).toBeGreaterThan(10);
    expect(new Set(values).size).toBe(values.length);
  });
});

// ─── Grupo 7: ListeningPublicationError ───────────────────────────────────────

describe('ListeningPublicationError', () => {
  it('preserva episodeId e code', () => {
    const e = new ListeningPublicationError(
      LISTENING_ERRORS.EPISODE_NOT_FOUND,
      'Not found',
      EP_ID,
    );
    expect(e.code).toBe(LISTENING_ERRORS.EPISODE_NOT_FOUND);
    expect(e.episodeId).toBe(EP_ID);
    expect(e.retryable).toBe(false);
  });

  it('suporta retryable=true', () => {
    const e = new ListeningPublicationError(
      LISTENING_ERRORS.STORAGE_COPY_FAILED,
      'Transient error',
      EP_ID,
      B1_ID,
      true,
    );
    expect(e.retryable).toBe(true);
    expect(e.blockId).toBe(B1_ID);
  });
});
