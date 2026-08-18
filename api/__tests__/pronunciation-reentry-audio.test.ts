/**
 * Reentry into "Treino de Pronúncia" the same day: reopening the screen must
 * return the SAME session/text with NO new generation, AND re-attach the
 * persisted reference audio from the shared library so no new Azure TTS call is
 * needed. The persisted audio is loaded from the shared item linked on the
 * session (shared_content_item_id) → Storage, never from a provider.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockGatewayDeps, aiOk } from './_ai-gateway-test-helpers';
import type { FeatureLimit, PlanEntitlementsSnapshot } from '../../src/domain/entitlements/entitlement-types';

const { mockCreate, mockRequireAuth, mockGetCurrentUserPlanEntitlements, mockResolveActivityPrompt, gw, serviceClientRef } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockRequireAuth: vi.fn(),
  mockGetCurrentUserPlanEntitlements: vi.fn(),
  mockResolveActivityPrompt: vi.fn(),
  gw: {} as ReturnType<typeof import('./_ai-gateway-test-helpers').createMockGatewayDeps>,
  serviceClientRef: { current: null as any },
}));

vi.mock('../_ai-gateway/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_ai-gateway/index')>();
  return { ...actual, getProductionDeps: () => gw.mockDeps };
});
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function () { return { chat: { completions: { create: mockCreate } } }; }),
}));
vi.mock('../_rateLimit', () => ({ applyRateLimit: vi.fn().mockResolvedValue(true), RATE_LIMITS: {} }));
vi.mock('../_auth', () => ({ requireAuth: mockRequireAuth }));
vi.mock('../_azure-speech', () => ({ issueAzureSpeechToken: vi.fn(), AzureSpeechError: class extends Error {} }));
vi.mock('../_azure-tts', () => ({ synthesizeSpeech: vi.fn(), AzureTtsSynthesisError: class extends Error {} }));
vi.mock('../_entitlements/plan-entitlements-service', () => ({ getCurrentUserPlanEntitlements: mockGetCurrentUserPlanEntitlements }));
vi.mock('../_curriculum/service-client', () => ({ getCurriculumServiceClient: () => serviceClientRef.current }));
vi.mock('../_curriculum/curriculum-runtime', () => ({
  resolveActivityPrompt: mockResolveActivityPrompt,
  ensureUserCurriculum: vi.fn(async () => ({ currentLevelCode: 'B1', languageContext: { learningLanguage: 'en', interfaceLanguage: 'pt-BR' }, versionId: 'version-1' })),
  recordCurricularPracticeFromIdentity: vi.fn(async () => ({ recorded: true })),
  CurriculumConfigError: class extends Error {},
}));

import handler from '../pronunciation-training/[...slug]';

const USER_ID = 'cccccccc-0000-0000-0000-000000000003';
const AUDIO_BYTES = 'AUDIO-BYTES';
const AUDIO_B64 = Buffer.from(AUDIO_BYTES).toString('base64');

function permissiveLimit(): FeatureLimit {
  return { enabled: true, unlimited: true, limit: 0, consumed: 0, remaining: Number.POSITIVE_INFINITY, period: 'day', state: 'unlimited', canStart: true };
}
function permissiveEntitlements(): PlanEntitlementsSnapshot {
  return {
    planId: 'plan-1', planCode: 'free', planName: 'Gratuito', planVersionId: 'version-1', suspended: false,
    writing: { enabled: true, themeGenerations: permissiveLimit(), reviews: permissiveLimit(), maxCharactersPerText: 0, maxCharactersUnlimited: true },
    listening: { enabled: true, stories: permissiveLimit() },
    pronunciation: { enabled: true, evaluations: permissiveLimit(), maxRecordingSeconds: 0, maxRecordingUnlimited: true },
    conversation: { enabled: true, monthlyTime: permissiveLimit(), maxRecordingSeconds: 0, maxRecordingUnlimited: true, extraPurchaseEnabled: false, extraSecondsAvailable: 0 },
    monthlyRenewsAt: null, resolvedAt: new Date().toISOString(),
  } as PlanEntitlementsSnapshot;
}

// supabase (user client): returns a single active (pending) session for today.
function makeSupabase(activeRow: Record<string, unknown> | null) {
  return {
    from: () => {
      const chain: any = {
        select: () => chain, eq: () => chain, neq: () => chain, order: () => chain, limit: () => chain,
        maybeSingle: async () => ({ data: activeRow, error: null }),
        then: (resolve: (v: unknown) => unknown) => resolve({ data: null, count: 0, error: null }),
      };
      return chain;
    },
    rpc: vi.fn(),
  };
}

// service-role client: resolves the linked shared item's READY audio + Storage bytes.
function makeServiceClient() {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            table === 'shared_content_items'
              ? { data: { audio_status: 'ready', audio_path: 'pronunciation/item-1.mp3', audio_mime_type: 'audio/mpeg', audio_voice: 'en-US-AvaMultilingualNeural', audio_locale: 'en-US' }, error: null }
              : { data: null, error: null },
        }),
      }),
    }),
    storage: {
      from: () => ({
        download: async () => ({ data: { arrayBuffer: async () => Buffer.from(AUDIO_BYTES) }, error: null }),
      }),
    },
  };
}

function makeReq() {
  return { method: 'POST', url: '/api/pronunciation-training/generate-text', headers: { authorization: 'Bearer t' }, body: {} };
}
function makeRes() {
  let _status = 200; let _body: any;
  const res: any = { _status: () => _status, _body: () => _body, status(s: number) { _status = s; return res; }, json(b: any) { _body = b; return res; }, setHeader: vi.fn() };
  return res;
}

const BASE_ACTIVE = {
  id: 'session-1', level: 'B1', generated_text: 'Read this aloud.', status: 'text_generated',
  pronunciation_score: null, accuracy_score: null, fluency_score: null, completeness_score: null,
  prosody_score: null, recognized_text: null, words_json: null, raw_result_json: null, audio_duration_seconds: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(gw, createMockGatewayDeps());
  gw.resetDefaults();
  mockCreate.mockImplementation(() => aiOk('should not be called'));
  mockGetCurrentUserPlanEntitlements.mockResolvedValue(permissiveEntitlements());
  serviceClientRef.current = makeServiceClient();
  process.env.OPENAI_API_KEY = 'test-key';
});

describe('pronunciation reentry — persisted audio reused, no generation', () => {
  it('reopening an existing session returns the same text + persisted audio, no OpenAI call', async () => {
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase: makeSupabase({ ...BASE_ACTIVE, shared_content_item_id: 'item-1' }) });
    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status()).toBe(200);
    expect(res._body().text).toBe('Read this aloud.');
    expect(res._body().sessionId).toBe('session-1');
    // The persisted reference audio is attached — client will NOT call /api/tts.
    expect(res._body().audio).toBeTruthy();
    expect(res._body().audio.base64).toBe(AUDIO_B64);
    expect(res._body().audio.voice).toBe('en-US-AvaMultilingualNeural');
    // No new text generation on reentry.
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('a session with no linked shared audio returns text only (client falls back to /api/tts)', async () => {
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase: makeSupabase({ ...BASE_ACTIVE, shared_content_item_id: null }) });
    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status()).toBe(200);
    expect(res._body().text).toBe('Read this aloud.');
    expect(res._body().audio).toBeUndefined(); // no broken/empty audio — fallback path
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
