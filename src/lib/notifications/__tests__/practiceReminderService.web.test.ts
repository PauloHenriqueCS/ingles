import { describe, it, expect, vi, beforeEach } from 'vitest';

// Plain web: no native shell, no LocalNotifications bridge.
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'web',
    isNativePlatform: () => false,
    isPluginAvailable: () => false,
  },
}));

// If the guard leaks, importing the plugin would blow up the assertion.
const shouldNotLoad = vi.fn();
vi.mock('@capacitor/local-notifications', () => {
  shouldNotLoad();
  return { LocalNotifications: {}, Weekday: {} };
});

import {
  isPracticeReminderSupported,
  schedulePracticeReminders,
  cancelPracticeReminders,
  syncPracticeReminders,
  getPracticeReminderPermission,
  __resetPracticeReminderServiceForTests,
} from '../practiceReminderService';

beforeEach(() => {
  vi.clearAllMocks();
  __resetPracticeReminderServiceForTests();
});

describe('practiceReminderService on web', () => {
  it('is not supported', () => {
    expect(isPracticeReminderSupported()).toBe(false);
  });

  it('every native operation is an inert no-op and never loads the plugin', async () => {
    expect(await getPracticeReminderPermission()).toBe('unsupported');
    expect(
      await schedulePracticeReminders({ enabled: true, weekdays: [1, 2], hour: 8, minute: 0 }, {
        title: 't',
        body: 'b',
        channelName: 'c',
      }),
    ).toBe(0);
    await expect(cancelPracticeReminders()).resolves.toBeUndefined();
    const res = await syncPracticeReminders(
      { enabled: true, weekdays: [1], hour: 8, minute: 0 },
      { title: 't', body: 'b', channelName: 'c' },
    );
    expect(res).toEqual({ supported: false, permission: 'unsupported', scheduled: false, count: 0 });
    expect(shouldNotLoad).not.toHaveBeenCalled();
  });
});
