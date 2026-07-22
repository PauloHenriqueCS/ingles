import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FeatureLimit, PlanEntitlementsSnapshot } from '../../src/domain/entitlements/entitlement-types';

const {
  mockRequireAuth,
  mockGetCurrentUserPlanEntitlements,
  mockGetListeningServiceClient,
  mockResolveUserListeningLevel,
  mockGetOrCreateListeningGroupJob,
  mockProcessListeningGroupGenerationStep,
  mockRetryListeningGroupGeneration,
} = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockGetCurrentUserPlanEntitlements: vi.fn(),
  mockGetListeningServiceClient: vi.fn(),
  mockResolveUserListeningLevel: vi.fn(),
  mockGetOrCreateListeningGroupJob: vi.fn(),
  mockProcessListeningGroupGenerationStep: vi.fn(),
  mockRetryListeningGroupGeneration: vi.fn(),
}));

vi.mock('../_auth', () => ({ requireAuth: mockRequireAuth }));
vi.mock('../_entitlements/plan-entitlements-service', () => ({
  getCurrentUserPlanEntitlements: mockGetCurrentUserPlanEntitlements,
}));
vi.mock('../../src/services/listening/publication/_supabase', () => ({
  getListeningServiceClient: mockGetListeningServiceClient,
}));
vi.mock('../../src/services/listening/daily/resolve-user-listening-level', () => ({
  resolveUserListeningLevel: mockResolveUserListeningLevel,
}));
vi.mock('../../src/services/listening/group-generation/get-or-create-listening-group-job', () => ({
  getOrCreateListeningGroupJob: mockGetOrCreateListeningGroupJob,
}));
vi.mock('../../src/services/listening/group-generation/process-listening-group-generation-step', () => ({
  processListeningGroupGenerationStep: mockProcessListeningGroupGenerationStep,
}));
vi.mock('../../src/services/listening/group-generation/retry-listening-group-generation', () => ({
  retryListeningGroupGeneration: mockRetryListeningGroupGeneration,
}));

import handler from '../listening/[...slug]';
import {
  GroupJobNotFoundError,
  GroupJobLockedError,
} from '../../src/services/listening/group-generation/listening-group-generation-types';

const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

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

function makeReq(slug: string, body: unknown = {}) {
  return {
    method: 'POST',
    headers: { authorization: 'Bearer test' },
    query: { slug },
    url: `/api/listening/${slug}`,
    body,
  };
}
function makeRes() {
  let _status = 200;
  let _body: unknown;
  const res = {
    _status: () => _status,
    _body: () => _body,
    status(s: number) { _status = s; return res; },
    json(b: unknown) { _body = b; return res; },
    setHeader() {},
  };
  return res;
}

function fakeGroupJobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1', level_group: 'A1_A2', target_level: 'A1', status: 'generating_block_1',
    current_step: 'Criando a primeira parte da história', progress_percent: 10, episode_id: null,
    attempts: 0, max_attempts: 3, error_code: null, error_message: null, retryable: false,
    ...overrides,
  };
}

describe('POST /api/listening/group/process-next', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase: {} });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(permissiveEntitlements());
    mockGetListeningServiceClient.mockReturnValue({});
    mockResolveUserListeningLevel.mockResolvedValue('A1');
  });

  it('resolves the caller level_group and advances the active/created job by one step', async () => {
    mockGetOrCreateListeningGroupJob.mockResolvedValue({
      kind: 'created',
      job: { id: 'job-1', levelGroup: 'A1_A2', targetLevel: 'A1' },
    });
    mockProcessListeningGroupGenerationStep.mockResolvedValue({
      jobId: 'job-1', levelGroup: 'A1_A2', targetLevel: 'A1', status: 'validating_block_1',
      currentStep: 'Validando a primeira parte', progressPercent: 20, episodeId: 'ep-1',
      attempts: 0, maxAttempts: 3, errorCode: null, errorMessage: null, retryable: false,
    });

    const res = makeRes();
    await handler(makeReq('group/process-next'), res);

    expect(mockGetOrCreateListeningGroupJob).toHaveBeenCalledWith(expect.anything(), 'A1_A2');
    expect(mockProcessListeningGroupGenerationStep).toHaveBeenCalledWith('job-1', expect.stringContaining(USER_ID.slice(0, 8)), expect.anything());
    expect(res._status()).toBe(200);
    expect((res._body() as any).status).toBe('validating_block_1');
  });

  it('never accepts a client-supplied jobId — request body is ignored for job selection', async () => {
    mockGetOrCreateListeningGroupJob.mockResolvedValue({
      kind: 'created',
      job: { id: 'job-1', levelGroup: 'A1_A2', targetLevel: 'A1' },
    });
    mockProcessListeningGroupGenerationStep.mockResolvedValue({
      jobId: 'job-1', levelGroup: 'A1_A2', targetLevel: 'A1', status: 'validating_block_1',
      currentStep: null, progressPercent: 20, episodeId: null,
      attempts: 0, maxAttempts: 3, errorCode: null, errorMessage: null, retryable: false,
    });

    const res = makeRes();
    // A caller trying to point this at an arbitrary internal job id — must be ignored.
    await handler(makeReq('group/process-next', { jobId: 'some-other-job-id' }), res);

    expect(mockProcessListeningGroupGenerationStep).toHaveBeenCalledWith('job-1', expect.anything(), expect.anything());
  });

  it('kind "reused": reports ready with the reused episodeId and never advances a step', async () => {
    mockGetOrCreateListeningGroupJob.mockResolvedValue({ kind: 'reused', episodeId: 'ep-shared-1' });

    const res = makeRes();
    await handler(makeReq('group/process-next'), res);

    expect(mockProcessListeningGroupGenerationStep).not.toHaveBeenCalled();
    expect(res._status()).toBe(200);
    const body = res._body() as any;
    expect(body.status).toBe('ready');
    expect(body.episodeId).toBe('ep-shared-1');
  });

  it('GroupJobLockedError (another poller mid-step) returns 200 with the current job status instead of an error', async () => {
    mockGetOrCreateListeningGroupJob.mockResolvedValue({
      kind: 'active',
      job: { id: 'job-1', levelGroup: 'A1_A2', targetLevel: 'A1' },
    });
    mockProcessListeningGroupGenerationStep.mockRejectedValue(new GroupJobLockedError());
    mockGetListeningServiceClient.mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: fakeGroupJobRow(), error: null }),
              }),
            }),
          }),
        }),
      }),
    });

    const res = makeRes();
    await handler(makeReq('group/process-next'), res);

    expect(res._status()).toBe(200);
    expect((res._body() as any).status).toBe('generating_block_1');
  });

  it('GroupJobNotFoundError returns 404', async () => {
    mockGetOrCreateListeningGroupJob.mockResolvedValue({
      kind: 'active',
      job: { id: 'job-1', levelGroup: 'A1_A2', targetLevel: 'A1' },
    });
    mockProcessListeningGroupGenerationStep.mockRejectedValue(new GroupJobNotFoundError('job-1'));

    const res = makeRes();
    await handler(makeReq('group/process-next'), res);

    expect(res._status()).toBe(404);
  });

  it('returns 403 FEATURE_DISABLED and never touches the group job when listening is disabled by plan', async () => {
    const entitlements = permissiveEntitlements();
    entitlements.listening.enabled = false;
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlements);

    const res = makeRes();
    await handler(makeReq('group/process-next'), res);

    expect(mockGetOrCreateListeningGroupJob).not.toHaveBeenCalled();
    expect(res._status()).toBe(403);
    expect((res._body() as any).code).toBe('FEATURE_DISABLED');
  });

  it('rejects GET (method guard)', async () => {
    const res = makeRes();
    await handler({ ...makeReq('group/process-next'), method: 'GET' }, res);
    expect(res._status()).toBe(405);
    expect(mockGetOrCreateListeningGroupJob).not.toHaveBeenCalled();
  });
});

describe('POST /api/listening/group/retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase: {} });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(permissiveEntitlements());
    mockResolveUserListeningLevel.mockResolvedValue('A1');
  });

  it('finds the latest job for the caller level_group and retries it', async () => {
    mockGetListeningServiceClient.mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: { id: 'job-1', status: 'failed' }, error: null }),
              }),
            }),
          }),
        }),
      }),
    });
    mockRetryListeningGroupGeneration.mockResolvedValue({
      jobId: 'job-1', levelGroup: 'A1_A2', targetLevel: 'A1', status: 'generating_block_1',
      currentStep: 'Criando a primeira parte da história', progressPercent: 10, episodeId: null,
      attempts: 1, maxAttempts: 3, errorCode: null, errorMessage: null, retryable: false,
    });

    const res = makeRes();
    await handler(makeReq('group/retry'), res);

    expect(mockRetryListeningGroupGeneration).toHaveBeenCalledWith('job-1', expect.anything());
    expect(res._status()).toBe(200);
    expect((res._body() as any).status).toBe('generating_block_1');
  });

  it('returns 404 when no job exists yet for the group', async () => {
    mockGetListeningServiceClient.mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          }),
        }),
      }),
    });

    const res = makeRes();
    await handler(makeReq('group/retry'), res);

    expect(mockRetryListeningGroupGeneration).not.toHaveBeenCalled();
    expect(res._status()).toBe(404);
  });
});
