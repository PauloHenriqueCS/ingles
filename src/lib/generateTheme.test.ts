import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockGatewayDeps } from '../../api/__tests__/_ai-gateway-test-helpers';
import type { FeatureLimit, PlanEntitlementsSnapshot } from '../domain/entitlements/entitlement-types';

// ── Hoist mock refs before vi.mock factory runs ───────────────────────────────

const { mockCreate, gw, mockResolveActivityPrompt } = vi.hoisted(() => {
  const mockCreate = vi.fn();
  const mockResolveActivityPrompt = vi.fn();
  return {
    mockCreate,
    mockResolveActivityPrompt,
    gw: {} as ReturnType<typeof import('../../api/__tests__/_ai-gateway-test-helpers').createMockGatewayDeps>,
  };
});

vi.mock('../../api/_auth', () => ({
  requireAuth: vi.fn(),
}));

const { mockGetCurrentUserPlanEntitlements } = vi.hoisted(() => ({
  mockGetCurrentUserPlanEntitlements: vi.fn(),
}));
vi.mock('../../api/_entitlements/plan-entitlements-service', () => ({
  getCurrentUserPlanEntitlements: mockGetCurrentUserPlanEntitlements,
}));

// Data-driven curriculum runtime — normal-mode writing prompts are now composed
// from the DB curriculum template `writing.generate_topic` (the hardcoded
// English SYSTEM_PROMPT + selected-theme prompt blocks were removed from the
// normal path). resolveActivityPrompt is stubbed to a fixed composed prompt
// (model null → handler falls back to AI_MODEL) so the parse/dedup/persist path
// is exercised exactly as before. importOriginal preserves the real
// CurriculumConfigError so the handler's `err instanceof CurriculumConfigError`
// 503 branch keeps working.
vi.mock('../../api/_curriculum/service-client', () => ({
  getCurriculumServiceClient: () => ({}),
}));
vi.mock('../../api/_curriculum/curriculum-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/_curriculum/curriculum-runtime')>();
  return {
    ...actual,
    resolveActivityPrompt: mockResolveActivityPrompt,
    recordCurricularPractice: vi.fn().mockResolvedValue({ recorded: true }),
  };
});

vi.mock('openai', () => ({
  default: vi.fn(function () {
    return { chat: { completions: { create: mockCreate } } };
  }),
}));

// generate-theme.ts wraps its OpenAI calls with the AI Gateway (Etapa 8).
// This suite predates that integration and never mocked it, which made
// getProductionDeps() try to build a real Supabase client and throw. Force
// legacy mode (the gateway's own zero-DB-dependency no-op path) so these
// tests exercise generate-theme.ts's own logic without any gateway/DB I/O.
vi.mock('../../api/_ai-gateway/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/_ai-gateway/index')>();
  return { ...actual, getProductionDeps: () => gw.mockDeps };
});

import { requireAuth } from '../../api/_auth';
import { WRITING_THEMES } from '../domain/writing/writing-themes';
import { CurriculumConfigError } from '../../api/_curriculum/curriculum-runtime';
import handler, {
  normalizeTheme,
  parseRawContent,
  jaccardSimilarity,
  isTooSimilar,
  normalizeReviewTheme,
  validateReviewTheme,
  applySelectedTopicOverride,
} from '../../api/generate-theme';

// ── Shared test helpers ───────────────────────────────────────────────────────

const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const THEME_DB_ID = 'bbbbbbbb-0000-0000-0000-000000000002';

/** Creates a chainable Supabase query stub that resolves to `result`. */
function makeChain(result: { data: unknown; error: unknown }) {
  const p = Promise.resolve(result);
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'insert', 'update', 'eq', 'neq', 'gte', 'lte', 'order']) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  c.limit       = vi.fn().mockReturnValue(p);
  c.single      = vi.fn().mockReturnValue(p);
  c.maybeSingle = vi.fn().mockReturnValue(p);
  return c;
}

/** A Supabase mock where select returns [] and insert returns a theme id. */
function makeDefaultSupabase() {
  const mockFrom = vi.fn((table: string) => {
    if (table === 'generated_themes') {
      // insert + single needs { data: { id } }
      // select/update needs { data: [], error: null }
      // We cover both by returning a chain that tracks which terminal was hit
      const insertChain = makeChain({ data: { id: THEME_DB_ID }, error: null });
      const selectChain = makeChain({ data: [], error: null });
      const updateChain = makeChain({ data: null, error: null });
      const outer: Record<string, unknown> = {
        select: vi.fn().mockReturnValue(selectChain),
        insert: vi.fn().mockReturnValue(insertChain),
        update: vi.fn().mockReturnValue(updateChain),
      };
      return outer;
    }
    return makeChain({ data: null, error: null });
  });
  const mockRpc = vi.fn().mockResolvedValue({ data: null, error: null });
  return { from: mockFrom, rpc: mockRpc };
}

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    body: {},
    headers: { authorization: 'Bearer test-token' },
    ...overrides,
  };
}

function makeRes() {
  const res = {
    _status: 200,
    _body: null as unknown,
    status(code: number) { res._status = code; return res; },
    json(body: unknown) { res._body = body; return res; },
    end() { return res; },
    setHeader() { return res; },
  };
  return res;
}

function aiResponse(content: string) {
  return Promise.resolve({ choices: [{ message: { content } }] });
}

/** Minimal valid theme JSON that normalizeTheme can parse. */
const VALID_THEME_JSON = JSON.stringify({
  title: 'Proposta ao gerente',
  missionSetup: 'Seu gerente pediu uma ideia.',
  missionTask: 'Escreva um e-mail explicando sua proposta.',
  mission: 'Seu gerente pediu uma ideia. Escreva um e-mail explicando sua proposta.',
  themePtBr: 'Seu gerente pediu uma ideia. Escreva um e-mail.',
  themeEn: 'Write an email to your manager.',
  format: 'e-mail',
  context: 'trabalho',
  conflict: 'tomou uma decisão importante',
  objective: 'convencer',
  activityType: 'e-mail',
  semanticSummary: 'Formato: e-mail | Conflito: decisão | Objetivo: convencer | cenário X',
  whyThisActivity: 'Praticar e-mail formal.',
  level: 'B1',
  difficulty: 'medium',
  estimatedTimeMinutes: 15,
  requiredGrammar: ['Present Simple'],
  suggestedVocabulary: [{ word: 'proposal', meaningPtBr: 'proposta', example: 'I have a proposal.' }],
  useTheseWords: ['proposal', 'idea'],
  instructions: ['Escreva 3 parágrafos.'],
  exampleSentence: 'Dear manager, I have a proposal.',
  successCriteria: ['3 parágrafos completos'],
  extraChallenge: '',
  category: 'work',
  grammarTips: { 'Present Simple': 'Use para fatos gerais.' },
  responseExamples: [],
});

function permissiveLimit(period: 'day' | 'month' | 'request' | 'none' = 'day'): FeatureLimit {
  return { enabled: true, unlimited: true, limit: 0, consumed: 0, remaining: Number.POSITIVE_INFINITY, period, state: 'unlimited', canStart: true };
}
function permissiveEntitlements(): PlanEntitlementsSnapshot {
  return {
    planId: 'plan-1', planCode: 'free', planName: 'Gratuito', planVersionId: 'version-1', suspended: false,
    writing: { enabled: true, themeGenerations: permissiveLimit('day'), reviews: permissiveLimit('day'), maxCharactersPerText: 0, maxCharactersUnlimited: true },
    listening: { enabled: true, stories: permissiveLimit('day') },
    pronunciation: { enabled: true, evaluations: permissiveLimit('day'), maxRecordingSeconds: 0, maxRecordingUnlimited: true },
    conversation: { enabled: true, monthlyTime: permissiveLimit('month'), maxRecordingSeconds: 0, maxRecordingUnlimited: true, extraPurchaseEnabled: false, extraSecondsAvailable: 0 },
    monthlyRenewsAt: null,
    resolvedAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');

  Object.assign(gw, createMockGatewayDeps());
  gw.resetDefaults(); // legacy mode — no telemetry, no DB dependency

  vi.mocked(requireAuth).mockResolvedValue({
    userId: USER_ID,
    supabase: makeDefaultSupabase() as any,
  });

  mockGetCurrentUserPlanEntitlements.mockResolvedValue(permissiveEntitlements());
  mockCreate.mockImplementation(() => aiResponse(VALID_THEME_JSON));

  // Fixed data-driven composed prompt for normal-mode generation. The handler
  // now sends `system`/`user` verbatim from this and falls back to AI_MODEL
  // when `model` is null. Tests that need to assert theme injection read the
  // opts passed to this mock (userContext.selected_theme).
  mockResolveActivityPrompt.mockResolvedValue({
    system: 'CURRICULUM_SYSTEM_PROMPT',
    user: 'Gere a missão de escrita agora.',
    model: null,
    temperature: 0.88,
    subtopicKey: 'recorte-1',
    versionId: 'ver-1',
    languageContext: { learningLanguage: 'en', interfaceLanguage: 'pt-BR' },
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

// ── parseRawContent ───────────────────────────────────────────────────────────

describe('parseRawContent', () => {
  it('parses clean JSON string', () => {
    const r = parseRawContent('{"a": 1}');
    expect(r).toEqual({ a: 1 });
  });

  it('extracts JSON embedded in surrounding text', () => {
    const r = parseRawContent('Here is the result: {"title": "test"} done.');
    expect(r).toEqual({ title: 'test' });
  });

  it('returns null for totally invalid content', () => {
    expect(parseRawContent('not json at all')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseRawContent('')).toBeNull();
  });

  it('returns null for broken JSON', () => {
    expect(parseRawContent('{broken')).toBeNull();
  });
});

// ── normalizeTheme ────────────────────────────────────────────────────────────

describe('normalizeTheme', () => {
  it('preserves title, missionSetup and missionTask from parsed input', () => {
    const t = normalizeTheme({ title: 'T', missionSetup: 'S', missionTask: 'K', format: 'e-mail', level: 'B1', difficulty: 'medium' });
    expect(t.title).toBe('T');
    expect(t.missionSetup).toBe('S');
    expect(t.missionTask).toBe('K');
  });

  it('builds mission from missionSetup + missionTask when mission absent', () => {
    const t = normalizeTheme({ missionSetup: 'Setup.', missionTask: 'Task.' });
    expect(t.mission).toBe('Setup. Task.');
    expect(t.themePtBr).toBe('Setup. Task.');
  });

  it('clamps invalid level to A1', () => {
    const t = normalizeTheme({ level: 'Z9' });
    expect(t.level).toBe('A1');
  });

  it('accepts all valid CEFR levels', () => {
    for (const lvl of ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']) {
      expect(normalizeTheme({ level: lvl }).level).toBe(lvl);
    }
  });

  it('clamps invalid difficulty to easy', () => {
    const t = normalizeTheme({ difficulty: 'superhard' });
    expect(t.difficulty).toBe('easy');
  });

  it('accepts easy/medium/hard difficulty', () => {
    for (const d of ['easy', 'medium', 'hard']) {
      expect(normalizeTheme({ difficulty: d }).difficulty).toBe(d);
    }
  });

  it('defaults arrays to [] when missing', () => {
    const t = normalizeTheme({});
    expect(t.requiredGrammar).toEqual([]);
    expect(t.suggestedVocabulary).toEqual([]);
    expect(t.useTheseWords).toEqual([]);
    expect(t.instructions).toEqual([]);
    expect(t.successCriteria).toEqual([]);
    expect(t.responseExamples).toEqual([]);
  });

  it('defaults estimatedTimeMinutes to 15 when absent', () => {
    expect(normalizeTheme({}).estimatedTimeMinutes).toBe(15);
  });

  it('builds semanticSummary with Formato/Conflito/Objetivo prefix', () => {
    const t = normalizeTheme({ format: 'e-mail', conflict: 'perdeu o voo', objective: 'convencer' });
    expect(t.semanticSummary).toContain('Formato: e-mail');
    expect(t.semanticSummary).toContain('Conflito: perdeu o voo');
    expect(t.semanticSummary).toContain('Objetivo: convencer');
  });

  it('sets activityType equal to format', () => {
    const t = normalizeTheme({ format: 'diário' });
    expect(t.activityType).toBe('diário');
  });

  it('falls back to activityType when format is absent', () => {
    const t = normalizeTheme({ activityType: 'historia' });
    expect(t.format).toBe('historia');
  });

  it('defaults grammarTips to {} when not an object', () => {
    expect(normalizeTheme({ grammarTips: ['array'] }).grammarTips).toEqual({});
    expect(normalizeTheme({ grammarTips: null }).grammarTips).toEqual({});
  });

  it('preserves grammarTips when it is an object', () => {
    const tips = { 'Present Perfect': 'use para experiências.' };
    expect(normalizeTheme({ grammarTips: tips }).grammarTips).toEqual(tips);
  });
});

// ── applySelectedTopicOverride ────────────────────────────────────────────────

describe('applySelectedTopicOverride', () => {
  it('força context para o tema selecionado, mesmo que a IA tenha escolhido outro', () => {
    const candidate: Record<string, unknown> = { context: 'trabalho' };
    applySelectedTopicOverride(candidate, 'Música');
    expect(candidate.context).toBe('Música');
  });

  it('não mexe em context quando nenhum tema foi selecionado (aleatório)', () => {
    const candidate: Record<string, unknown> = { context: 'trabalho' };
    applySelectedTopicOverride(candidate, null);
    expect(candidate.context).toBe('trabalho');
  });
});

// ── jaccardSimilarity ─────────────────────────────────────────────────────────

describe('jaccardSimilarity', () => {
  it('identical strings → 1.0', () => {
    expect(jaccardSimilarity('hello world test', 'hello world test')).toBe(1);
  });

  it('completely different strings → 0', () => {
    expect(jaccardSimilarity('apple banana cherry', 'xylophone zamboni quasar')).toBe(0);
  });

  it('empty strings → 0', () => {
    expect(jaccardSimilarity('', '')).toBe(0);
  });

  it('filters stopwords — short tokens ignored', () => {
    // "de" and "a" and "o" are stopwords
    const sim = jaccardSimilarity('de carro novo', 'o carro velho');
    // only meaningful token shared is "carro"
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });

  it('is symmetric', () => {
    const a = 'proposta gerente reunião projeto';
    const b = 'projeto reunião cliente feedback';
    expect(jaccardSimilarity(a, b)).toBe(jaccardSimilarity(b, a));
  });

  it('normalizes accents before comparison', () => {
    // "situação" and "situacao" should be treated the same after NFD normalization
    const sim = jaccardSimilarity('situação trabalho', 'situacao trabalho');
    expect(sim).toBeGreaterThan(0.5);
  });
});

// ── isTooSimilar ──────────────────────────────────────────────────────────────

describe('isTooSimilar', () => {
  const recentThemes = [
    {
      title: 'Proposta ao gerente',
      activity_type: 'e-mail',
      context: 'trabalho',
      semantic_summary: 'Formato: e-mail | Conflito: perdeu o voo | Objetivo: convencer | cenário trabalho',
    },
  ];

  it('identical candidate to recent theme → too similar', () => {
    const candidate = {
      title: 'Proposta ao gerente',
      format: 'e-mail',
      context: 'trabalho',
      conflict: 'perdeu o voo',
      objective: 'convencer',
      semanticSummary: 'Formato: e-mail | Conflito: perdeu o voo | Objetivo: convencer | cenário trabalho',
      missionSetup: 'Proposta ao gerente',
    };
    expect(isTooSimilar(candidate, recentThemes)).toBe(true);
  });

  it('completely different candidate → not too similar', () => {
    const candidate = {
      title: 'Crítica ao restaurante',
      format: 'review',
      context: 'restaurante',
      conflict: 'recebeu o pedido errado',
      objective: 'reclamar',
      semanticSummary: 'Formato: review | Conflito: pedido errado | cenário restaurante',
      missionSetup: 'O garçom trouxe o prato errado.',
    };
    expect(isTooSimilar(candidate, recentThemes)).toBe(false);
  });

  it('same format as most recent → too similar regardless of content', () => {
    const candidate = {
      title: 'Totally different content here',
      format: 'e-mail',  // same as recentThemes[0].activity_type
      context: 'saude',
      conflict: 'encontrou um velho amigo',
      objective: 'agradecer',
      semanticSummary: 'Formato: e-mail | diferente',
      missionSetup: 'Totalmente diferente',
    };
    expect(isTooSimilar(candidate, recentThemes)).toBe(true);
  });

  it('empty history → never too similar', () => {
    expect(isTooSimilar({ title: 'anything', format: 'e-mail' }, [])).toBe(false);
  });

  it('custom threshold 0.9 → only flags very high similarity', () => {
    const candidate = {
      title: 'Proposta diferente mas trabalho',
      format: 'review',
      context: 'trabalho',
      conflict: 'cliente reclamou',
      objective: 'convencer',
      semanticSummary: 'Formato: review | trabalho',
      missionSetup: 'Proposta diferente',
    };
    // At threshold 0.9, moderate similarity should NOT be flagged
    expect(isTooSimilar(candidate, recentThemes, 0.9)).toBe(false);
  });
});

// ── normalizeReviewTheme ──────────────────────────────────────────────────────

describe('normalizeReviewTheme', () => {
  const GROUP_ID = 'group-uuid-123';
  const EXPECTED_WORDS = ['therefore', 'although'];

  const parsed = {
    title: 'Revisão especial',
    missionSetup: 'Você precisa usar as palavras.',
    missionTask: 'Escreva um texto usando therefore e although.',
    themeEn: 'Write using the required words.',
    objective: 'praticar conectores',
    activityType: 'narrative',
    context: 'trabalho',
    level: 'B1',
    difficulty: 'medium',
    estimatedTimeMinutes: 15,
    requiredGrammar: ['Connectors'],
    requiredWords: ['therefore', 'although'],
    suggestedVocabulary: [{ word: 'however', meaningPtBr: 'porém', example: 'However, I disagree.' }],
    instructions: ['Use as palavras obrigatórias.'],
    exampleSentence: 'Although I was tired, I worked.',
    successCriteria: ['Usou therefore e although corretamente.'],
    mode: 'review',
    reviewGroupId: GROUP_ID,
  };

  it('sets mode to review', () => {
    const t = normalizeReviewTheme(parsed, GROUP_ID, EXPECTED_WORDS);
    expect(t.mode).toBe('review');
  });

  it('copies reviewGroupId exactly', () => {
    const t = normalizeReviewTheme(parsed, GROUP_ID, EXPECTED_WORDS);
    expect(t.reviewGroupId).toBe(GROUP_ID);
  });

  it('deduplicates requiredWords', () => {
    const t = normalizeReviewTheme({ ...parsed, requiredWords: ['therefore', 'therefore', 'although'] }, GROUP_ID, EXPECTED_WORDS);
    expect(t.requiredWords).toEqual(['therefore', 'although']);
  });

  it('falls back to expectedWords when requiredWords absent', () => {
    const t = normalizeReviewTheme({ ...parsed, requiredWords: undefined }, GROUP_ID, EXPECTED_WORDS);
    expect(t.requiredWords).toEqual(EXPECTED_WORDS);
  });

  it('sets conflict to empty string', () => {
    const t = normalizeReviewTheme(parsed, GROUP_ID, EXPECTED_WORDS);
    expect(t.conflict).toBe('');
  });

  it('clamps invalid level to A1', () => {
    const t = normalizeReviewTheme({ ...parsed, level: 'Z9' }, GROUP_ID, EXPECTED_WORDS);
    expect(t.level).toBe('A1');
  });

  it('defaults to difficulty easy when invalid', () => {
    const t = normalizeReviewTheme({ ...parsed, difficulty: 'extreme' }, GROUP_ID, EXPECTED_WORDS);
    expect(t.difficulty).toBe('easy');
  });

  it('builds mission from missionSetup + missionTask', () => {
    const t = normalizeReviewTheme(parsed, GROUP_ID, EXPECTED_WORDS);
    expect(t.mission).toContain('Você precisa usar as palavras.');
    expect(t.mission).toContain('Escreva um texto');
  });
});

// ── validateReviewTheme ───────────────────────────────────────────────────────

describe('validateReviewTheme', () => {
  const GROUP_ID = 'group-uuid-123';
  const EXPECTED_WORDS = ['therefore', 'although'];

  function validTheme(): Record<string, unknown> {
    return {
      title: 'Revisão',
      mission: 'Missão de revisão.',
      mode: 'review',
      reviewGroupId: GROUP_ID,
      requiredWords: ['therefore', 'although'],
      suggestedVocabulary: [{ word: 'however' }],
    };
  }

  it('returns null for a valid theme', () => {
    expect(validateReviewTheme(validTheme(), EXPECTED_WORDS, GROUP_ID)).toBeNull();
  });

  it('fails when a required word is missing', () => {
    const t = { ...validTheme(), requiredWords: ['therefore'] };
    const err = validateReviewTheme(t, EXPECTED_WORDS, GROUP_ID);
    expect(err).toContain('although');
  });

  it('fails when extra word is present', () => {
    const t = { ...validTheme(), requiredWords: ['therefore', 'although', 'moreover'] };
    const err = validateReviewTheme(t, EXPECTED_WORDS, GROUP_ID);
    expect(err).toContain('moreover');
  });

  it('fails when requiredWords contains duplicates', () => {
    const t = { ...validTheme(), requiredWords: ['therefore', 'therefore'] };
    expect(validateReviewTheme(t, ['therefore'], GROUP_ID)).toContain('duplicata');
  });

  it('fails when title is empty', () => {
    const t = { ...validTheme(), title: '' };
    expect(validateReviewTheme(t, EXPECTED_WORDS, GROUP_ID)).toContain('title');
  });

  it('fails when mission is empty', () => {
    const t = { ...validTheme(), mission: '' };
    expect(validateReviewTheme(t, EXPECTED_WORDS, GROUP_ID)).toContain('mission');
  });

  it('fails when mode is not review', () => {
    const t = { ...validTheme(), mode: 'normal' };
    expect(validateReviewTheme(t, EXPECTED_WORDS, GROUP_ID)).toContain('mode');
  });

  it('fails when reviewGroupId does not match', () => {
    const t = { ...validTheme(), reviewGroupId: 'wrong-id' };
    expect(validateReviewTheme(t, EXPECTED_WORDS, GROUP_ID)).toContain('reviewGroupId');
  });

  it('fails when suggestedVocabulary repeats a required word', () => {
    const t = {
      ...validTheme(),
      suggestedVocabulary: [{ word: 'therefore' }],
    };
    const err = validateReviewTheme(t, EXPECTED_WORDS, GROUP_ID);
    expect(err).toContain('therefore');
  });
});

// ── handler — método HTTP ─────────────────────────────────────────────────────

describe('handler — método HTTP', () => {
  it('retorna 405 para GET', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'GET' }), res);
    expect(res._status).toBe(405);
  });

  it('retorna 405 para DELETE', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'DELETE' }), res);
    expect(res._status).toBe(405);
  });
});

// ── handler — autenticação ────────────────────────────────────────────────────

describe('handler — autenticação', () => {
  it('retorna 401 quando requireAuth retorna null', async () => {
    vi.mocked(requireAuth).mockResolvedValue(null);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('não chama a OpenAI sem autenticação', async () => {
    vi.mocked(requireAuth).mockResolvedValue(null);
    await handler(makeReq(), makeRes());
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

// ── handler — chave de API ausente ───────────────────────────────────────────

describe('handler — OPENAI_API_KEY ausente', () => {
  it('retorna 503 quando a chave não está configurada', async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('OPENAI_API_KEY', '');
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(503);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

// ── handler — modo normal, fluxo feliz ───────────────────────────────────────

describe('handler — modo normal', () => {
  it('retorna 200 com tema e themeId', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(200);
    const body = res._body as Record<string, unknown>;
    expect(body).toHaveProperty('theme');
    expect(body).toHaveProperty('themeId');
    expect(body.mode).toBe('normal');
  });

  it('tema retornado contém campos obrigatórios', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    const theme = (res._body as Record<string, unknown>).theme as Record<string, unknown>;
    expect(theme).toHaveProperty('title');
    expect(theme).toHaveProperty('mission');
    expect(theme).toHaveProperty('level');
    expect(theme).toHaveProperty('difficulty');
    expect(Array.isArray(theme.instructions)).toBe(true);
    expect(Array.isArray(theme.requiredGrammar)).toBe(true);
  });

  it('nível inválido da IA é normalizado para A1', async () => {
    mockCreate.mockImplementation(() =>
      aiResponse(JSON.stringify({ ...JSON.parse(VALID_THEME_JSON), level: 'Z9' })),
    );
    const res = makeRes();
    await handler(makeReq(), res);
    const theme = (res._body as Record<string, unknown>).theme as Record<string, unknown>;
    expect(theme.level).toBe('A1');
  });

  it('dificuldade inválida da IA é normalizada para easy', async () => {
    mockCreate.mockImplementation(() =>
      aiResponse(JSON.stringify({ ...JSON.parse(VALID_THEME_JSON), difficulty: 'unknown' })),
    );
    const res = makeRes();
    await handler(makeReq(), res);
    const theme = (res._body as Record<string, unknown>).theme as Record<string, unknown>;
    expect(theme.difficulty).toBe('easy');
  });

  it('resposta não contém OPENAI_API_KEY', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(JSON.stringify(res._body)).not.toContain('test-openai-key');
  });

  it('JSON inválido da IA após todas as tentativas → 500', async () => {
    mockCreate.mockImplementation(() => aiResponse('not json'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(500);
  });

  it('falha do provider após todas as tentativas → 500', async () => {
    mockCreate.mockRejectedValue(new Error('network error'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(500);
  });

  it('excludedTheme no body é passado para o histórico de exclusão', async () => {
    const excluded = { title: 'Tema recusado', format: 'review', context: 'trabalho', semanticSummary: '' };
    const req = makeReq({ body: { excludedTheme: excluded } });
    const res = makeRes();
    await handler(req, res);
    // Should succeed since the theme from AI is different enough
    expect(res._status).toBe(200);
    expect(mockCreate).toHaveBeenCalled();
  });

  it('tema gerado não expõe userId na resposta', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    const serialized = JSON.stringify(res._body);
    expect(serialized).not.toContain(USER_ID);
  });
});

// ── handler — tema selecionado (Missão do dia) via currículo data-driven ─────
//
// O bloco de "tema obrigatório" hardcoded no prompt (texto em PT injetado
// direto na mensagem do usuário) foi REMOVIDO do caminho normal. O endpoint
// ainda recebe o valor técnico do select (ex: 'football_sports') e o converte
// para o label canônico via src/domain/writing/writing-themes.ts (nunca uma
// segunda lista) — mas agora esse label é entregue ao motor de currículo
// através de `userContext.selected_theme`, e é o template do banco que decide
// como usá-lo. Estas provas verificam o contrato data-driven (o que o handler
// passa para resolveActivityPrompt), não mais o texto interno do prompt.

describe('handler — tema selecionado (Missão do dia) via currículo', () => {
  it('converte o valor técnico do select para o label canônico e o injeta em userContext.selected_theme', async () => {
    const req = makeReq({ body: { theme: 'football_sports' } });
    await handler(req, makeRes());

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockResolveActivityPrompt).toHaveBeenCalledWith(
      expect.anything(),
      USER_ID,
      expect.objectContaining({
        templateKey: 'writing.generate_topic',
        activityType: 'writing',
        userContext: { selected_theme: 'Futebol e esportes' },
      }),
    );
  });

  it('funciona para cada valor técnico do catálogo canônico (mesma lista do select)', async () => {
    for (const t of WRITING_THEMES) {
      mockResolveActivityPrompt.mockClear();
      const req = makeReq({ body: { theme: t.value } });
      await handler(req, makeRes());
      const opts = mockResolveActivityPrompt.mock.calls[0][2] as { userContext?: Record<string, unknown> };
      expect(opts.userContext).toEqual({ selected_theme: t.label });
    }
  });

  it('"tema aleatório" (campo ausente) não injeta selected_theme algum no currículo', async () => {
    const req = makeReq({ body: {} });
    await handler(req, makeRes());
    const opts = mockResolveActivityPrompt.mock.calls[0][2] as { userContext?: unknown };
    expect(opts.userContext).toBeUndefined();
  });

  it('"tema aleatório" (theme: null explícito) também não injeta selected_theme', async () => {
    const req = makeReq({ body: { theme: null } });
    await handler(req, makeRes());
    const opts = mockResolveActivityPrompt.mock.calls[0][2] as { userContext?: unknown };
    expect(opts.userContext).toBeUndefined();
  });

  it('valor de theme desconhecido/inválido é tratado como aleatório, sem quebrar', async () => {
    const req = makeReq({ body: { theme: 'not_a_real_theme_value' } });
    const res = makeRes();
    await handler(req, res);

    expect(res._status).toBe(200);
    const opts = mockResolveActivityPrompt.mock.calls[0][2] as { userContext?: unknown };
    expect(opts.userContext).toBeUndefined();
  });

  it('não faz nenhuma chamada de IA extra além da que já existia (1 tentativa quando a primeira é válida)', async () => {
    const req = makeReq({ body: { theme: 'travel' } });
    await handler(req, makeRes());
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('o prompt composto (system/user) nunca vaza na resposta HTTP como texto de debug', async () => {
    const req = makeReq({ body: { theme: 'football_sports' } });
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(200);
    const serialized = JSON.stringify(res._body);
    expect(serialized).not.toContain('CURRICULUM_SYSTEM_PROMPT');
    expect(serialized).not.toContain('Gere a missão de escrita agora.');
  });

  it('a tag/context final reflete o tema selecionado mesmo que a IA retorne um context diferente', async () => {
    mockCreate.mockImplementation(() =>
      aiResponse(JSON.stringify({ ...JSON.parse(VALID_THEME_JSON), context: 'trabalho' })),
    );
    const req = makeReq({ body: { theme: 'music' } });
    const res = makeRes();
    await handler(req, res);
    const theme = (res._body as Record<string, unknown>).theme as Record<string, unknown>;
    expect(theme.context).toBe('Música');
  });

  it('sem tema selecionado, o context retornado continua sendo o que a IA escolheu (sem override)', async () => {
    const req = makeReq({ body: {} });
    const res = makeRes();
    await handler(req, res);
    const theme = (res._body as Record<string, unknown>).theme as Record<string, unknown>;
    expect(theme.context).toBe('trabalho');
  });
});

// ── handler — currículo mal configurado → 503 CURRICULUM_NOT_CONFIGURED ───────
//
// Substitui a antiga suíte de "cache diagnóstico" (o caminho diagnóstico e o
// cache de missão foram REMOVIDOS do endpoint). O novo contrato data-driven:
// um currículo ausente/mal configurado é um erro operacional explícito, nunca
// um fallback silencioso para um prompt hardcoded em inglês.

describe('handler — currículo mal configurado', () => {
  it('retorna 503 CURRICULUM_NOT_CONFIGURED e nunca chama a IA quando o currículo não está configurado', async () => {
    mockResolveActivityPrompt.mockRejectedValueOnce(
      new CurriculumConfigError('No published curriculum for learning_language="en"'),
    );
    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status).toBe(503);
    expect((res._body as Record<string, unknown>).code).toBe('CURRICULUM_NOT_CONFIGURED');
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

// ── handler — regeneração ─────────────────────────────────────────────────────

describe('handler — regeneração (previousThemeId)', () => {
  it('marca tema anterior como regenerated quando previousThemeId é fornecido', async () => {
    const updateSpy = vi.fn().mockReturnValue(makeChain({ data: null, error: null }));
    const mockSupa = makeDefaultSupabase();
    (mockSupa as any).from = vi.fn((table: string) => {
      if (table === 'generated_themes') {
        const insertChain = makeChain({ data: { id: THEME_DB_ID }, error: null });
        const selectChain = makeChain({ data: [], error: null });
        return {
          select: vi.fn().mockReturnValue(selectChain),
          insert: vi.fn().mockReturnValue(insertChain),
          update: updateSpy,
        };
      }
      return makeChain({ data: null, error: null });
    });
    vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, supabase: mockSupa as any });

    const req = makeReq({ body: { previousThemeId: 'prev-theme-id' } });
    await handler(req, makeRes());
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'regenerated' }));
  });

  it('tema anterior não é marcado como completed na regeneração', async () => {
    const updateSpy = vi.fn().mockReturnValue(makeChain({ data: null, error: null }));
    const mockSupa = makeDefaultSupabase();
    (mockSupa as any).from = vi.fn((table: string) => {
      if (table === 'generated_themes') {
        const insertChain = makeChain({ data: { id: THEME_DB_ID }, error: null });
        const selectChain = makeChain({ data: [], error: null });
        return {
          select: vi.fn().mockReturnValue(selectChain),
          insert: vi.fn().mockReturnValue(insertChain),
          update: updateSpy,
        };
      }
      return makeChain({ data: null, error: null });
    });
    vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, supabase: mockSupa as any });

    await handler(makeReq({ body: { previousThemeId: 'prev-id' } }), makeRes());
    if (updateSpy.mock.calls.length > 0) {
      const updateArg = updateSpy.mock.calls[0][0] as Record<string, unknown>;
      expect(updateArg.status).not.toBe('completed');
    }
  });
});

// ── handler — modo revisão ────────────────────────────────────────────────────

const REVIEW_GROUP_JSON = JSON.stringify({
  title: 'Revisão de conectores',
  missionSetup: 'Você precisa praticar os conectores.',
  missionTask: 'Escreva um texto usando therefore e although.',
  mission: 'Você precisa praticar. Escreva usando therefore e although.',
  themeEn: 'Write using the connectors.',
  objective: 'praticar conectores',
  pedagogicalReason: 'Reforçar uso de conectores.',
  activityType: 'narrative',
  format: 'narrative',
  context: 'trabalho',
  conflict: '',
  semanticSummary: 'Formato: narrative | Objetivo: praticar',
  level: 'B1',
  difficulty: 'medium',
  estimatedTimeMinutes: 15,
  requiredGrammar: ['Connectors'],
  requiredWords: ['therefore', 'although'],
  suggestedVocabulary: [{ word: 'however', meaningPtBr: 'porém', example: 'However, I agree.' }],
  useTheseWords: [],
  instructions: ['Use as palavras obrigatórias.'],
  exampleSentence: 'Although I was tired, I worked.',
  successCriteria: ['Usou as palavras obrigatórias.'],
  extraChallenge: '',
  category: 'review',
  grammarTips: {},
  responseExamples: [],
  mode: 'review',
  reviewGroupId: 'group-uuid-123',
});

describe('handler — modo revisão', () => {
  const validReviewGroup = {
    group: { id: 'group-uuid-123', originalTheme: 'Missão original', sourceEntryDate: '2026-01-15', reviewLevel: 0 },
    items: [
      { originalValue: 'therefor', correctedValue: 'therefore', explanation: 'Conector causal', originalSentence: null },
      { originalValue: 'altough', correctedValue: 'although', explanation: 'Conector de contraste', originalSentence: null },
    ],
  };

  beforeEach(() => {
    mockCreate.mockImplementation(() => aiResponse(REVIEW_GROUP_JSON));
  });

  it('retorna 400 quando group.id está ausente', async () => {
    const req = makeReq({ body: { mode: 'review', reviewGroup: { group: { id: '' }, items: [{ correctedValue: 'test' }] } } });
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it('retorna 400 quando items está vazio', async () => {
    const req = makeReq({ body: { mode: 'review', reviewGroup: { group: { id: 'g-1' }, items: [] } } });
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it('fluxo feliz retorna mode: review com tema e themeId', async () => {
    const req = makeReq({ body: { mode: 'review', reviewGroup: validReviewGroup } });
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(200);
    const body = res._body as Record<string, unknown>;
    expect(body.mode).toBe('review');
    expect(body).toHaveProperty('theme');
    expect(body).toHaveProperty('themeId');
  });

  it('tema de revisão tem mode=review e reviewGroupId correto', async () => {
    const req = makeReq({ body: { mode: 'review', reviewGroup: validReviewGroup } });
    const res = makeRes();
    await handler(req, res);
    const theme = (res._body as Record<string, unknown>).theme as Record<string, unknown>;
    expect(theme.mode).toBe('review');
    expect(theme.reviewGroupId).toBe(validReviewGroup.group.id);
  });

  it('AI inválida em todos os retries → 500', async () => {
    mockCreate.mockImplementation(() => aiResponse('invalid json'));
    const req = makeReq({ body: { mode: 'review', reviewGroup: validReviewGroup } });
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(500);
  });

  it('falha do provider → 500', async () => {
    mockCreate.mockRejectedValue(new Error('AI down'));
    const req = makeReq({ body: { mode: 'review', reviewGroup: validReviewGroup } });
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(500);
  });
});

// ── handler — modo revisão IGNORAVA o tema selecionado (bug real) ────────────
//
// Bug real: quando uma revisão espaçada está pendente, o frontend força
// mode='review' em toda solicitação, independente do tema escolhido pelo
// usuário no seletor. O branch de revisão do endpoint nunca lia o campo
// `theme` — a missão era construída só a partir dos erros corrigidos e do
// `reviewGroup.group.originalTheme` (ex: uma entrada antiga sobre viagem),
// ignorando silenciosamente "Música". Corrigido: buildReviewUserMessage
// agora recebe o tema selecionado e injeta um bloco TEMA OBRIGATÓRIO, e o
// context final da missão é forçado deterministicamente no servidor.

describe('handler — modo revisão com tema selecionado (Missão do dia ignorava o tema)', () => {
  const oldTravelReviewGroup = {
    group: {
      id: 'group-uuid-456',
      originalTheme: 'Planejando uma viagem para Paris',
      sourceEntryDate: '2026-01-10',
      reviewLevel: 1,
    },
    items: [
      { originalValue: 'therefor', correctedValue: 'therefore', explanation: 'Conector causal', originalSentence: null },
      { originalValue: 'altough', correctedValue: 'although', explanation: 'Conector de contraste', originalSentence: null },
    ],
  };

  beforeEach(() => {
    // Simula a IA ainda se apoiando no contexto de viagem do grupo de
    // revisão (title/context) — prova que é o override determinístico, e
    // não apenas o prompt, que garante o resultado final.
    mockCreate.mockImplementation(() =>
      aiResponse(JSON.stringify({
        ...JSON.parse(REVIEW_GROUP_JSON),
        title: 'Planejando uma Viagem dos Sonhos',
        context: 'viagens',
      })),
    );
  });

  // Data-driven: the review prompt now lives in the DB template
  // `writing.generate_review_activity`. The dynamically-built review context
  // (which carries the TEMA OBRIGATÓRIO block when a theme is selected) flows to
  // the curriculum engine via userContext.review_context — not as raw text
  // injected into the OpenAI user message. So we assert on what the handler
  // hands to resolveActivityPrompt.
  it('injeta TEMA OBRIGATÓRIO no review_context de revisão quando um tema é selecionado', async () => {
    const req = makeReq({ body: { mode: 'review', reviewGroup: oldTravelReviewGroup, theme: 'music' } });
    await handler(req, makeRes());

    const opts = mockResolveActivityPrompt.mock.calls[0][2] as { templateKey: string; userContext?: Record<string, string> };
    expect(opts.templateKey).toBe('writing.generate_review_activity');
    const reviewContext = opts.userContext?.review_context ?? '';
    expect(reviewContext).toContain('TEMA OBRIGATÓRIO ESCOLHIDO PELO USUÁRIO: Música.');
    expect(reviewContext).toContain('mesmo que o tema original do grupo de revisão abaixo seja outro');
  });

  it('deixa explícito no review_context que requiredWords não é afetado pelo tema', async () => {
    const req = makeReq({ body: { mode: 'review', reviewGroup: oldTravelReviewGroup, theme: 'music' } });
    await handler(req, makeRes());

    const opts = mockResolveActivityPrompt.mock.calls[0][2] as { userContext?: Record<string, string> };
    expect(opts.userContext?.review_context ?? '').toContain('Isso NUNCA afeta requiredWords');
  });

  it('a missão antiga de viagem não é reaproveitada: a tag final reflete Música, não o tema original do grupo', async () => {
    const req = makeReq({ body: { mode: 'review', reviewGroup: oldTravelReviewGroup, theme: 'music' } });
    const res = makeRes();
    await handler(req, res);

    expect(res._status).toBe(200);
    const theme = (res._body as Record<string, unknown>).theme as Record<string, unknown>;
    expect(theme.context).toBe('Música');
    expect(theme.context).not.toBe('viagens');
  });

  it('requiredWords continua vindo exatamente dos erros do aluno mesmo com tema selecionado', async () => {
    const req = makeReq({ body: { mode: 'review', reviewGroup: oldTravelReviewGroup, theme: 'music' } });
    const res = makeRes();
    await handler(req, res);

    const theme = (res._body as Record<string, unknown>).theme as Record<string, unknown>;
    expect(theme.requiredWords).toEqual(['therefore', 'although']);
  });

  it('sem tema selecionado, o modo revisão mantém o comportamento anterior (sem bloco de tema obrigatório)', async () => {
    const req = makeReq({ body: { mode: 'review', reviewGroup: oldTravelReviewGroup } });
    await handler(req, makeRes());

    const opts = mockResolveActivityPrompt.mock.calls[0][2] as { userContext?: Record<string, string> };
    expect(opts.userContext?.review_context ?? '').not.toContain('TEMA OBRIGATÓRIO');
  });

  it('funciona para todo o catálogo canônico de temas também no modo revisão', async () => {
    for (const t of WRITING_THEMES) {
      mockCreate.mockClear();
      mockResolveActivityPrompt.mockClear();
      const req = makeReq({ body: { mode: 'review', reviewGroup: oldTravelReviewGroup, theme: t.value } });
      await handler(req, makeRes());
      const opts = mockResolveActivityPrompt.mock.calls[0][2] as { userContext?: Record<string, string> };
      expect(opts.userContext?.review_context ?? '').toContain(`TEMA OBRIGATÓRIO ESCOLHIDO PELO USUÁRIO: ${t.label}.`);
    }
  });
});
