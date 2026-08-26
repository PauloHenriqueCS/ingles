import { describe, it, expect, vi, beforeEach } from 'vitest';

// The lib imports the real supabase singleton (throws without env) and
// authSession — mock both, the technique used across this codebase's lib tests.
const { mockGetCurrentUserId, mockFrom, mockUpsert, mockMaybeSingle } = vi.hoisted(() => ({
  mockGetCurrentUserId: vi.fn(),
  mockFrom: vi.fn(),
  mockUpsert: vi.fn(),
  mockMaybeSingle: vi.fn(),
}));

vi.mock('../supabase', () => ({ supabase: { from: mockFrom } }));
vi.mock('../authSession', () => ({ getCurrentUserId: mockGetCurrentUserId }));

import { fetchPracticeReminder, savePracticeReminder } from '../practiceReminder';
import { DEFAULT_PRACTICE_REMINDER } from '../../domain/practiceReminder/practiceReminder';

const USER = 'user-uuid-1';

beforeEach(() => {
  vi.clearAllMocks();
  // Chainable select().eq().maybeSingle() and upsert().
  mockFrom.mockReturnValue({
    select: () => ({ eq: () => ({ maybeSingle: mockMaybeSingle }) }),
    upsert: mockUpsert,
  });
  mockUpsert.mockResolvedValue({ error: null });
  mockMaybeSingle.mockResolvedValue({ data: null, error: null });
});

describe('fetchPracticeReminder', () => {
  it('returns the default when no user is signed in', async () => {
    mockGetCurrentUserId.mockResolvedValue(null);
    expect(await fetchPracticeReminder()).toEqual(DEFAULT_PRACTICE_REMINDER);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('returns the default when the user has no saved row', async () => {
    mockGetCurrentUserId.mockResolvedValue(USER);
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await fetchPracticeReminder()).toEqual(DEFAULT_PRACTICE_REMINDER);
    expect(mockFrom).toHaveBeenCalledWith('user_practice_reminder_preferences');
  });

  it('normalizes the stored row (dedupe/sort weekdays, clamp time)', async () => {
    mockGetCurrentUserId.mockResolvedValue(USER);
    mockMaybeSingle.mockResolvedValue({
      data: { enabled: true, weekdays: [5, 1, 3, 3], hour: 20, minute: 0 },
      error: null,
    });
    expect(await fetchPracticeReminder()).toEqual({
      enabled: true,
      weekdays: [1, 3, 5],
      hour: 20,
      minute: 0,
    });
  });

  it('falls back to default on a query error', async () => {
    mockGetCurrentUserId.mockResolvedValue(USER);
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: 'boom' } });
    expect(await fetchPracticeReminder()).toEqual(DEFAULT_PRACTICE_REMINDER);
  });
});

describe('savePracticeReminder', () => {
  it('throws when unauthenticated', async () => {
    mockGetCurrentUserId.mockResolvedValue(null);
    await expect(
      savePracticeReminder({ enabled: true, weekdays: [1], hour: 8, minute: 0 }),
    ).rejects.toThrow();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('upserts the normalized preference keyed on user_id', async () => {
    mockGetCurrentUserId.mockResolvedValue(USER);
    const result = await savePracticeReminder({
      enabled: true,
      weekdays: [3, 1, 1],
      hour: 19,
      minute: 30,
    });

    expect(result.weekdays).toEqual([1, 3]);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const [payload, opts] = mockUpsert.mock.calls[0];
    expect(payload).toMatchObject({
      user_id: USER,
      enabled: true,
      weekdays: [1, 3],
      hour: 19,
      minute: 30,
    });
    expect(payload.updated_at).toBeTypeOf('string');
    expect(opts).toEqual({ onConflict: 'user_id' });
  });

  it('propagates a persistence error', async () => {
    mockGetCurrentUserId.mockResolvedValue(USER);
    mockUpsert.mockResolvedValue({ error: { message: 'rls denied' } });
    await expect(
      savePracticeReminder({ enabled: false, weekdays: [], hour: 8, minute: 0 }),
    ).rejects.toThrow('rls denied');
  });
});
