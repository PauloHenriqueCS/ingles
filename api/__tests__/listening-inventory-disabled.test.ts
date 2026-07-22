/**
 * Tests for the retirement of preventive Listening inventory generation
 * (Etapa: shared level-group generation). Covers:
 *  - GET  /api/internal/listening/inventory/ensure  -> disabled no-op
 *  - POST /api/internal/listening/supply {action:"generate"} -> disabled no-op
 *  - GET  /api/internal/listening/repair -> now also recovers stuck shared
 *    listening_generation_jobs rows (group-generation), reusing the same
 *    cron slot instead of a new one.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockCheckCronAuth,
  mockGetJobsServiceClient,
  mockRecoverStuckListeningJobs,
  mockRecoverStuckListeningGroupJobs,
} = vi.hoisted(() => ({
  mockCheckCronAuth: vi.fn(),
  mockGetJobsServiceClient: vi.fn(),
  mockRecoverStuckListeningJobs: vi.fn(),
  mockRecoverStuckListeningGroupJobs: vi.fn(),
}));

vi.mock('../internal/_auth', () => ({ checkCronAuth: mockCheckCronAuth }));
vi.mock('../../src/services/listening/jobs/_supabase', () => ({
  getJobsServiceClient: mockGetJobsServiceClient,
}));
vi.mock('../../src/services/listening/jobs/recover-stuck-listening-jobs', () => ({
  recoverStuckListeningJobs: mockRecoverStuckListeningJobs,
}));
vi.mock('../../src/services/listening/group-generation/recover-stuck-listening-group-jobs', () => ({
  recoverStuckListeningGroupJobs: mockRecoverStuckListeningGroupJobs,
}));

import handler from '../internal/listening/[...slug]';

function makeReq(url: string, method: 'GET' | 'POST' = 'GET', body: unknown = {}) {
  return { method, url, headers: { authorization: 'Bearer cron-secret' }, body };
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

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckCronAuth.mockReturnValue(true);
  mockGetJobsServiceClient.mockReturnValue({});
  mockRecoverStuckListeningJobs.mockResolvedValue({ recoveredCount: 0, jobIds: [] });
  mockRecoverStuckListeningGroupJobs.mockResolvedValue({ recoveredCount: 0, jobIds: [] });
});

describe('GET /api/internal/listening/inventory/ensure — disabled', () => {
  it('returns a disabled no-op response and creates nothing', async () => {
    const res = makeRes();
    await handler(makeReq('/api/internal/listening/inventory/ensure'), res);

    expect(res._status()).toBe(200);
    const body = res._body() as any;
    expect(body.disabled).toBe(true);
    expect(body.pipelinesCreated).toBe(0);
    expect(body.levels).toEqual([]);
  });
});

describe('POST /api/internal/listening/supply {action:"generate"} — disabled', () => {
  it('returns a disabled no-op response instead of enqueuing preventive pipelines', async () => {
    const res = makeRes();
    await handler(makeReq('/api/internal/listening/supply', 'POST', { action: 'generate' }), res);

    expect(res._status()).toBe(200);
    const body = res._body() as any;
    expect(body.success).toBe(true);
    expect(body.disabled).toBe(true);
    expect(body.pipelinesCreated).toBe(0);
    expect(body.levelsAffected).toEqual([]);
  });

  it('still validates the level parameter before reporting disabled', async () => {
    const res = makeRes();
    await handler(makeReq('/api/internal/listening/supply', 'POST', { action: 'generate', level: 'Z9' }), res);

    expect(res._status()).toBe(400);
  });
});

describe('GET /api/internal/listening/repair — now recovers shared group jobs too', () => {
  it('calls both recovery mechanisms and merges their results, without a new cron', async () => {
    mockRecoverStuckListeningJobs.mockResolvedValue({ recoveredCount: 1, jobIds: ['session-1'] });
    mockRecoverStuckListeningGroupJobs.mockResolvedValue({ recoveredCount: 2, jobIds: ['job-1', 'job-2'] });

    const res = makeRes();
    await handler(makeReq('/api/internal/listening/repair'), res);

    expect(mockRecoverStuckListeningJobs).toHaveBeenCalledTimes(1);
    expect(mockRecoverStuckListeningGroupJobs).toHaveBeenCalledTimes(1);
    expect(res._status()).toBe(200);
    const body = res._body() as any;
    expect(body.recovered).toBe(1);
    expect(body.jobIds).toEqual(['session-1']);
    expect(body.groupRecovered).toBe(2);
    expect(body.groupJobIds).toEqual(['job-1', 'job-2']);
  });
});
