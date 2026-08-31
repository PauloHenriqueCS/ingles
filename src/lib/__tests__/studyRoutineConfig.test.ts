import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Chainable Supabase mock (repo convention: vi.mock('../supabase')) ──────────
const mockMaybeSingle = vi.fn();
const mockEq = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
const mockSelect = vi.fn(() => ({ eq: mockEq }));
const mockUpsert = vi.fn();
const mockFrom = vi.fn(() => ({ select: mockSelect, upsert: mockUpsert }));

vi.mock('../supabase', () => ({ supabase: { from: (...args: unknown[]) => mockFrom(...args) } }));
vi.mock('../authSession', () => ({ getCurrentUserId: vi.fn() }));

import { getCurrentUserId } from '../authSession';
import {
  fetchStudyRoutineStatus,
  markStudyRoutineConfigured,
} from '../studyRoutineConfig';

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  asMock(getCurrentUserId).mockResolvedValue('user-1');
});

describe('fetchStudyRoutineStatus', () => {
  it('returns null (unknown → fail safe, never trap) when unauthenticated', async () => {
    asMock(getCurrentUserId).mockResolvedValue(null);
    expect(await fetchStudyRoutineStatus()).toBeNull();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('maps NO ROW to "unconfigured" (a brand-new user must configure)', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await fetchStudyRoutineStatus()).toBe('unconfigured');
    expect(mockFrom).toHaveBeenCalledWith('user_study_routine_config');
    expect(mockEq).toHaveBeenCalledWith('user_id', 'user-1');
  });

  it('returns null on a backend error (fail safe — never trap behind the gate)', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: 'boom' } });
    expect(await fetchStudyRoutineStatus()).toBeNull();
  });

  it('passes through a persisted configured status', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { status: 'configured' }, error: null });
    expect(await fetchStudyRoutineStatus()).toBe('configured');
  });
});

describe('markStudyRoutineConfigured', () => {
  it('upserts a configured row keyed by user_id with a configured_at stamp', async () => {
    mockUpsert.mockResolvedValue({ error: null });
    await markStudyRoutineConfigured();
    expect(mockFrom).toHaveBeenCalledWith('user_study_routine_config');
    const [payload, opts] = mockUpsert.mock.calls[0];
    expect(payload).toMatchObject({ user_id: 'user-1', status: 'configured' });
    expect(payload.configured_at).toBeTruthy();
    expect(opts).toEqual({ onConflict: 'user_id' });
  });

  it('throws a friendly error when the write fails', async () => {
    mockUpsert.mockResolvedValue({ error: { message: 'nope' } });
    await expect(markStudyRoutineConfigured()).rejects.toThrow('nope');
  });
});
