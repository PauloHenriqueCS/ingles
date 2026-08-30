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
  fetchTutorialStatus,
  markTutorialCompleted,
  markTutorialSkipped,
} from '../tutorialProgress';

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  asMock(getCurrentUserId).mockResolvedValue('user-1');
});

describe('fetchTutorialStatus', () => {
  it('returns null (unknown → fail safe, never auto-show) when unauthenticated', async () => {
    asMock(getCurrentUserId).mockResolvedValue(null);
    expect(await fetchTutorialStatus()).toBeNull();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('maps NO ROW to "pending" (a brand-new user should see the tutorial)', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await fetchTutorialStatus()).toBe('pending');
    expect(mockFrom).toHaveBeenCalledWith('user_tutorial_progress');
    expect(mockEq).toHaveBeenCalledWith('user_id', 'user-1');
  });

  it('returns null on a backend error (fail safe — do not force the tutorial)', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: 'boom' } });
    expect(await fetchTutorialStatus()).toBeNull();
  });

  it('passes through a persisted completed/skipped status', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { status: 'completed' }, error: null });
    expect(await fetchTutorialStatus()).toBe('completed');
    mockMaybeSingle.mockResolvedValue({ data: { status: 'skipped' }, error: null });
    expect(await fetchTutorialStatus()).toBe('skipped');
  });
});

describe('markTutorialCompleted / markTutorialSkipped', () => {
  it('upserts a completed row keyed by user_id with a completed_at stamp', async () => {
    mockUpsert.mockResolvedValue({ error: null });
    await markTutorialCompleted();
    expect(mockFrom).toHaveBeenCalledWith('user_tutorial_progress');
    const [payload, opts] = mockUpsert.mock.calls[0];
    expect(payload).toMatchObject({ user_id: 'user-1', status: 'completed' });
    expect(payload.completed_at).toBeTruthy();
    expect(opts).toEqual({ onConflict: 'user_id' });
  });

  it('upserts a skipped row keyed by user_id with a skipped_at stamp', async () => {
    mockUpsert.mockResolvedValue({ error: null });
    await markTutorialSkipped();
    const [payload, opts] = mockUpsert.mock.calls[0];
    expect(payload).toMatchObject({ user_id: 'user-1', status: 'skipped' });
    expect(payload.skipped_at).toBeTruthy();
    expect(opts).toEqual({ onConflict: 'user_id' });
  });

  it('throws a friendly error when the write fails', async () => {
    mockUpsert.mockResolvedValue({ error: { message: 'nope' } });
    await expect(markTutorialCompleted()).rejects.toThrow('nope');
  });
});
