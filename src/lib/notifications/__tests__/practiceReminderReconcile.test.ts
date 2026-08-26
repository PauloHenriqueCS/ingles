import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the native service so we can spy on the orchestration; buildReminderCopy
// is left REAL so the tests prove the actual localization end-to-end.
const {
  mockSupported,
  mockGetPermission,
  mockSync,
  mockCancel,
  mockFetchPref,
  mockGetLang,
} = vi.hoisted(() => ({
  mockSupported: vi.fn(() => true),
  mockGetPermission: vi.fn(),
  mockSync: vi.fn(),
  mockCancel: vi.fn(),
  mockFetchPref: vi.fn(),
  mockGetLang: vi.fn(),
}));

vi.mock('../practiceReminderService', () => ({
  isPracticeReminderSupported: mockSupported,
  getPracticeReminderPermission: mockGetPermission,
  syncPracticeReminders: mockSync,
  cancelPracticeReminders: mockCancel,
}));
vi.mock('../../practiceReminder', () => ({ fetchPracticeReminder: mockFetchPref }));
vi.mock('../../interfaceLanguage', () => ({ getCurrentInterfaceLanguage: mockGetLang }));

import { reconcilePracticeReminders } from '../practiceReminderReconcile';

const ACTIVE = { enabled: true, weekdays: [1, 3], hour: 7, minute: 15 };
const USER = 'user-1';

function lastSyncCopy() {
  return mockSync.mock.calls.at(-1)?.[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSupported.mockReturnValue(true);
  mockGetPermission.mockResolvedValue('granted');
  mockSync.mockResolvedValue({ scheduled: true });
  mockCancel.mockResolvedValue(undefined);
  mockFetchPref.mockResolvedValue(ACTIVE);
  mockGetLang.mockResolvedValue('pt-BR');
});

describe('reconcilePracticeReminders — language follows the current interfaceLanguage', () => {
  it('login re-sync for a pt-BR user schedules pt-BR copy', async () => {
    mockGetLang.mockResolvedValue('pt-BR');
    await reconcilePracticeReminders(USER);
    expect(mockSync).toHaveBeenCalledTimes(1);
    expect(mockSync.mock.calls[0][0]).toEqual(ACTIVE);
    expect(lastSyncCopy()).toMatchObject({ title: 'Hora de praticar' });
  });

  it('login re-sync for an EN user schedules English copy (no need to re-save)', async () => {
    mockGetLang.mockResolvedValue('en');
    await reconcilePracticeReminders(USER);
    expect(lastSyncCopy()).toMatchObject({
      title: 'Time to practice',
      body: 'How about continuing your English practice today?',
    });
  });

  it('resume re-sync (same reconcile, run again) stays in English for an EN user', async () => {
    mockGetLang.mockResolvedValue('en');
    await reconcilePracticeReminders(USER); // login
    await reconcilePracticeReminders(USER); // appStateChange/resume
    expect(mockSync).toHaveBeenCalledTimes(2);
    expect(mockSync.mock.calls[0][1]).toMatchObject({ title: 'Time to practice' });
    expect(mockSync.mock.calls[1][1]).toMatchObject({ title: 'Time to practice' });
  });

  it('falls back to pt-BR only when no valid language resolves', async () => {
    mockGetLang.mockResolvedValue(null);
    await reconcilePracticeReminders(USER);
    expect(lastSyncCopy()).toMatchObject({ title: 'Hora de praticar' });
  });
});

describe('reconcilePracticeReminders — session/permission/platform gating (unchanged behavior)', () => {
  it('logout (no userId) cancels and never reads the preference', async () => {
    await reconcilePracticeReminders(null);
    expect(mockCancel).toHaveBeenCalledTimes(1);
    expect(mockFetchPref).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('without granted permission it cancels and never schedules or prompts', async () => {
    mockGetPermission.mockResolvedValue('denied');
    await reconcilePracticeReminders(USER);
    expect(mockCancel).toHaveBeenCalledTimes(1);
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('is a no-op when unsupported (web)', async () => {
    mockSupported.mockReturnValue(false);
    await reconcilePracticeReminders(USER);
    expect(mockGetPermission).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
    expect(mockCancel).not.toHaveBeenCalled();
  });
});
