/**
 * Endpoint tests for GET /api/conversation/variants
 * (api/conversation/[...slug].ts -> handleVariants).
 *
 * ROOT-2, item 3: the tutor-personalization UI must fetch its accent/variant
 * OPTIONS from an endpoint driven by DATA for the user's ACTIVE learning
 * language — never a hardcoded english list. English returns
 * american/british/neutral because that is what conversation_language_variants
 * holds for 'en'; a DIFFERENT learning language returns ITS OWN variants through
 * the SAME code (proved here with a Spanish fixture), with no union/switch/UI
 * change. Labels are localized by the active interface_language (pt-BR
 * fallback), ordered by sort_order.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAuth, mockEnsureUserCurriculum, mockVariantsFrom } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockEnsureUserCurriculum: vi.fn(),
  mockVariantsFrom: vi.fn(),
}));

vi.mock('../_auth', () => ({ requireAuth: mockRequireAuth }));
vi.mock('../_curriculum/service-client', () => ({
  getCurriculumServiceClient: () => ({ from: mockVariantsFrom }),
}));
vi.mock('../_curriculum/curriculum-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_curriculum/curriculum-runtime')>();
  return { ...actual, ensureUserCurriculum: mockEnsureUserCurriculum };
});

import handler from '../conversation/[...slug]';
import { CurriculumConfigError } from '../_curriculum/curriculum-runtime';

const USER_ID = 'aaaaaaaa-0000-0000-0000-0000000000aa';

interface VariantRow {
  variant_key: string;
  display_label: string | null;
  is_default: boolean;
  sort_order: number | null;
  interface_language: string;
  learning_language: string;
}

/** Real filtering (learning_language eq + interface_language in) so the test
 *  proves the route reads the per-language catalog, not a passthrough. */
function setCatalog(rows: VariantRow[], errorOnRead = false) {
  mockVariantsFrom.mockImplementation((table: string) => {
    expect(table).toBe('conversation_language_variants');
    let filtered = [...rows];
    const builder: any = {
      select: () => builder,
      eq: (col: string, val: unknown) => {
        filtered = filtered.filter((r) => (r as any)[col] === val);
        return builder;
      },
      in: (col: string, vals: unknown[]) => {
        if (errorOnRead) return Promise.resolve({ data: null, error: { message: 'boom' } });
        filtered = filtered.filter((r) => vals.includes((r as any)[col]));
        return Promise.resolve({ data: filtered, error: null });
      },
    };
    return builder;
  });
}

function ensured(learningLanguage: string, interfaceLanguage: string) {
  return {
    prefs: { conversation: false },
    languageContext: { learningLanguage, interfaceLanguage },
    currentLevelCode: 'A1',
    currentSubtopicKey: null,
    versionId: 'v-1',
  };
}

function makeReq(overrides: Record<string, unknown> = {}) {
  return { method: 'GET', url: '/api/conversation/variants', headers: { authorization: 'Bearer test-token' }, ...overrides };
}

function makeRes() {
  let _status = 200;
  let _body: unknown;
  const res = {
    _status: () => _status,
    _body: () => _body,
    status(s: number) { _status = s; return res; },
    json(b: unknown) { _body = b; return res; },
    setHeader: vi.fn(),
  };
  return res;
}

// English catalog: american/british/neutral, pt-BR labels + en fallback rows.
const EN_CATALOG: VariantRow[] = [
  { learning_language: 'en', variant_key: 'american', display_label: 'Americano', is_default: true,  sort_order: 0, interface_language: 'pt-BR' },
  { learning_language: 'en', variant_key: 'british',  display_label: 'Britânico', is_default: false, sort_order: 1, interface_language: 'pt-BR' },
  { learning_language: 'en', variant_key: 'neutral',  display_label: 'Neutro',    is_default: false, sort_order: 2, interface_language: 'pt-BR' },
  // an en-interface row for american proves exact-language label wins over pt-BR.
  { learning_language: 'en', variant_key: 'american', display_label: 'American', is_default: true, sort_order: 0, interface_language: 'en' },
];

// Spanish catalog (test-only): a DIFFERENT variant set — no production seed.
const ES_CATALOG: VariantRow[] = [
  { learning_language: 'es', variant_key: 'latin_american', display_label: 'Latino-americano', is_default: true,  sort_order: 0, interface_language: 'pt-BR' },
  { learning_language: 'es', variant_key: 'spain',          display_label: 'Espanha',          is_default: false, sort_order: 1, interface_language: 'pt-BR' },
  { learning_language: 'es', variant_key: 'neutral',        display_label: 'Neutro',           is_default: false, sort_order: 2, interface_language: 'pt-BR' },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase: {} });
});

describe('GET /api/conversation/variants', () => {
  it('English active path → american/british/neutral from DATA, ordered by sort_order', async () => {
    mockEnsureUserCurriculum.mockResolvedValue(ensured('en', 'pt-BR'));
    setCatalog([...EN_CATALOG, ...ES_CATALOG]);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status()).toBe(200);
    const body = res._body() as { learningLanguage: string; variants: { key: string; label: string; isDefault: boolean }[] };
    expect(body.learningLanguage).toBe('en');
    expect(body.variants).toEqual([
      { key: 'american', label: 'Americano', isDefault: true },
      { key: 'british', label: 'Britânico', isDefault: false },
      { key: 'neutral', label: 'Neutro', isDefault: false },
    ]);
  });

  it('a DIFFERENT learning language returns ITS OWN variants through the same code (ROOT-2)', async () => {
    mockEnsureUserCurriculum.mockResolvedValue(ensured('es', 'pt-BR'));
    setCatalog([...EN_CATALOG, ...ES_CATALOG]);

    const res = makeRes();
    await handler(makeReq(), res);

    const body = res._body() as { learningLanguage: string; variants: { key: string }[] };
    expect(body.learningLanguage).toBe('es');
    expect(body.variants.map((v) => v.key)).toEqual(['latin_american', 'spain', 'neutral']);
    expect(body.variants.map((v) => v.key)).not.toContain('american');
  });

  it('503 CURRICULUM_NOT_CONFIGURED when the active path is not configured, never querying the catalog', async () => {
    mockEnsureUserCurriculum.mockRejectedValue(new CurriculumConfigError('no path'));
    setCatalog(EN_CATALOG);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status()).toBe(503);
    expect((res._body() as { code: string }).code).toBe('CURRICULUM_NOT_CONFIGURED');
    expect(mockVariantsFrom).not.toHaveBeenCalled();
  });

  it('500 INTERNAL_ERROR when the catalog read fails', async () => {
    mockEnsureUserCurriculum.mockResolvedValue(ensured('en', 'pt-BR'));
    setCatalog(EN_CATALOG, /* errorOnRead */ true);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status()).toBe(500);
    expect((res._body() as { code: string }).code).toBe('INTERNAL_ERROR');
  });

  it('never resolves the path or queries the catalog when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValue(null);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(mockEnsureUserCurriculum).not.toHaveBeenCalled();
    expect(mockVariantsFrom).not.toHaveBeenCalled();
  });

  it('returns 405 for a non-GET method, before auth', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'POST' }), res);

    expect(res._status()).toBe(405);
    expect(mockRequireAuth).not.toHaveBeenCalled();
  });
});
