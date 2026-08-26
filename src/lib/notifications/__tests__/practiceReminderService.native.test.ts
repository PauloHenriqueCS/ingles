import { describe, it, expect, vi, beforeEach } from 'vitest';

// Simulate a native Android Capacitor shell with the LocalNotifications bridge.
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'android',
    isNativePlatform: () => true,
    isPluginAvailable: (name: string) => name === 'LocalNotifications',
  },
}));

const mockSchedule = vi.fn().mockResolvedValue(undefined);
const mockCancel = vi.fn().mockResolvedValue(undefined);
const mockGetPending = vi.fn().mockResolvedValue({ notifications: [] });
const mockCreateChannel = vi.fn().mockResolvedValue(undefined);
const mockCheckPermissions = vi.fn().mockResolvedValue({ display: 'granted' });
const mockRequestPermissions = vi.fn().mockResolvedValue({ display: 'granted' });
const mockAddListener = vi.fn().mockResolvedValue({ remove: vi.fn() });

vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    schedule: (o: unknown) => mockSchedule(o),
    cancel: (o: unknown) => mockCancel(o),
    getPending: () => mockGetPending(),
    createChannel: (o: unknown) => mockCreateChannel(o),
    checkPermissions: () => mockCheckPermissions(),
    requestPermissions: () => mockRequestPermissions(),
    addListener: (e: string, cb: unknown) => mockAddListener(e, cb),
  },
  Weekday: { Sunday: 1, Monday: 2, Tuesday: 3, Wednesday: 4, Thursday: 5, Friday: 6, Saturday: 7 },
}));

import {
  isPracticeReminderSupported,
  schedulePracticeReminders,
  cancelPracticeReminders,
  syncPracticeReminders,
  getPracticeReminderPermission,
  __resetPracticeReminderServiceForTests,
} from '../practiceReminderService';
import {
  PRACTICE_REMINDER_IDS,
  type PracticeReminderPreference,
} from '../../../domain/practiceReminder/practiceReminder';

const COPY = { title: 'Hora de praticar', body: 'Vamos?', channelName: 'Lembrete de prática' };

function scheduledNotifications() {
  // Last schedule() call's notifications array.
  const call = mockSchedule.mock.calls.at(-1)?.[0] as { notifications: any[] } | undefined;
  return call?.notifications ?? [];
}
function scheduledIds() {
  return scheduledNotifications().map((n) => n.id).sort((a, b) => a - b);
}
function cancelledIds() {
  const call = mockCancel.mock.calls.at(-1)?.[0] as { notifications: { id: number }[] } | undefined;
  return (call?.notifications ?? []).map((n) => n.id).sort((a, b) => a - b);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckPermissions.mockResolvedValue({ display: 'granted' });
  mockRequestPermissions.mockResolvedValue({ display: 'granted' });
  mockGetPending.mockResolvedValue({ notifications: [] });
  __resetPracticeReminderServiceForTests();
});

describe('support gate', () => {
  it('is supported on native with the bridge present', () => {
    expect(isPracticeReminderSupported()).toBe(true);
  });
});

describe('schedulePracticeReminders', () => {
  const monWedFri: PracticeReminderPreference = {
    enabled: true,
    weekdays: [1, 3, 5],
    hour: 8,
    minute: 0,
  };

  it('creates exactly one weekly schedule per selected day (Mon+Wed+Fri → 3)', async () => {
    const count = await schedulePracticeReminders(monWedFri, COPY);
    expect(count).toBe(3);
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect(scheduledNotifications()).toHaveLength(3);
  });

  it('uses deterministic reserved ids and the plugin weekday mapping', async () => {
    await schedulePracticeReminders(monWedFri, COPY);
    const notifs = scheduledNotifications();
    // ids are BASE + isoDay: Mon..101, Wed..103, Fri..105.
    expect(scheduledIds()).toEqual([
      PRACTICE_REMINDER_IDS[0], // Mon (base+1)
      PRACTICE_REMINDER_IDS[2], // Wed (base+3)
      PRACTICE_REMINDER_IDS[4], // Fri (base+5)
    ]);
    const byId = Object.fromEntries(notifs.map((n) => [n.id, n.schedule.on]));
    expect(byId[PRACTICE_REMINDER_IDS[0]]).toMatchObject({ weekday: 2, hour: 8, minute: 0 }); // Mon→2
    expect(byId[PRACTICE_REMINDER_IDS[2]].weekday).toBe(4); // Wed→4
    expect(byId[PRACTICE_REMINDER_IDS[4]].weekday).toBe(6); // Fri→6
    // Each repeats weekly + fires while idle.
    expect(notifs[0].schedule.allowWhileIdle).toBe(true);
  });

  it('schedules every reminder as an INEXACT alarm (isExactNotification: false)', async () => {
    // Single day (Monday) — flag lives on the NOTIFICATION, not on schedule.
    await schedulePracticeReminders({ enabled: true, weekdays: [1], hour: 9, minute: 0 }, COPY);
    expect(scheduledNotifications()).toHaveLength(1);
    expect(scheduledNotifications()[0].isExactNotification).toBe(false);
    // It must NOT be nested inside schedule (where the plugin ignores it).
    expect(scheduledNotifications()[0].schedule).not.toHaveProperty('isExactNotification');

    // … and every day across a multi-day config.
    await schedulePracticeReminders(monWedFri, COPY);
    const notifs = scheduledNotifications();
    expect(notifs).toHaveLength(3);
    for (const n of notifs) {
      expect(n.isExactNotification).toBe(false); // notification level
      expect(n.schedule).not.toHaveProperty('isExactNotification'); // never on schedule
      expect(n.schedule.allowWhileIdle).toBe(true); // never a mandatory exact alarm
    }
  });

  it('attaches the practice-reminders channelId when the channel is available', async () => {
    await schedulePracticeReminders(monWedFri, COPY);
    for (const n of scheduledNotifications()) expect(n.channelId).toBe('practice-reminders');
  });

  it('schedules WITHOUT channelId when the channel could not be created (default-channel fallback)', async () => {
    mockCreateChannel.mockRejectedValueOnce(new Error('channel create failed'));
    const count = await schedulePracticeReminders(monWedFri, COPY);
    expect(count).toBe(3);
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    // No notification references the (missing) channel — it would fall back to
    // the default channel rather than silently not firing.
    for (const n of scheduledNotifications()) {
      expect(n).not.toHaveProperty('channelId');
      expect(n.isExactNotification).toBe(false); // still inexact
    }
  });

  it('clears the whole reserved range before scheduling (no leftovers)', async () => {
    await schedulePracticeReminders(monWedFri, COPY);
    // cancel was called with all 7 reserved ids prior to schedule.
    expect(cancelledIds()).toEqual([...PRACTICE_REMINDER_IDS].sort((a, b) => a - b));
  });

  it('is idempotent — saving the same config twice does not duplicate', async () => {
    await schedulePracticeReminders(monWedFri, COPY);
    await schedulePracticeReminders(monWedFri, COPY);
    expect(mockSchedule).toHaveBeenCalledTimes(2);
    // Same 3 deterministic ids both times — no accumulation.
    expect(scheduledIds()).toEqual([
      PRACTICE_REMINDER_IDS[0],
      PRACTICE_REMINDER_IDS[2],
      PRACTICE_REMINDER_IDS[4],
    ]);
  });

  it('changing the config removes the old days (they are within the cancelled range)', async () => {
    await schedulePracticeReminders(monWedFri, COPY);
    await schedulePracticeReminders({ enabled: true, weekdays: [2, 4], hour: 19, minute: 0 }, COPY);
    // New schedule only Tue+Thu.
    expect(scheduledIds()).toEqual([PRACTICE_REMINDER_IDS[1], PRACTICE_REMINDER_IDS[3]]);
    // The pre-schedule cancel covered the full reserved range, so Mon/Wed/Fri are gone.
    expect(cancelledIds()).toEqual([...PRACTICE_REMINDER_IDS].sort((a, b) => a - b));
  });

  it('empty weekdays cancels instead of scheduling', async () => {
    const count = await schedulePracticeReminders(
      { enabled: true, weekdays: [], hour: 8, minute: 0 },
      COPY,
    );
    expect(count).toBe(0);
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockCancel).toHaveBeenCalled();
  });

  it('creates the Android notification channel', async () => {
    await schedulePracticeReminders(monWedFri, COPY);
    expect(mockCreateChannel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'practice-reminders', name: COPY.channelName }),
    );
  });
});

describe('cancelPracticeReminders', () => {
  it('cancels exactly the reserved id range', async () => {
    await cancelPracticeReminders();
    expect(mockCancel).toHaveBeenCalledTimes(1);
    expect(cancelledIds()).toEqual([...PRACTICE_REMINDER_IDS].sort((a, b) => a - b));
    expect(mockSchedule).not.toHaveBeenCalled();
  });
});

describe('syncPracticeReminders (reconcile intent → device)', () => {
  const active: PracticeReminderPreference = { enabled: true, weekdays: [1, 3], hour: 7, minute: 15 };

  it('schedules when enabled, has days, and permission is granted', async () => {
    const res = await syncPracticeReminders(active, COPY);
    expect(res).toMatchObject({ supported: true, permission: 'granted', scheduled: true, count: 2 });
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });

  it('a re-sync still schedules INEXACT alarms', async () => {
    await syncPracticeReminders(active, COPY);
    for (const n of scheduledNotifications()) {
      expect(n.isExactNotification).toBe(false);
      expect(n.schedule).not.toHaveProperty('isExactNotification');
    }
  });

  it('does NOT schedule when the preference is disabled — it cancels', async () => {
    const res = await syncPracticeReminders(
      { enabled: false, weekdays: [1, 3], hour: 7, minute: 15 },
      COPY,
    );
    expect(res.scheduled).toBe(false);
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockCancel).toHaveBeenCalled();
  });

  it('does NOT schedule when permission is not granted — it cancels', async () => {
    mockCheckPermissions.mockResolvedValue({ display: 'denied' });
    const res = await syncPracticeReminders(active, COPY);
    expect(res).toMatchObject({ permission: 'denied', scheduled: false });
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockCancel).toHaveBeenCalled();
  });

  it('never prompts for permission during a sync', async () => {
    await syncPracticeReminders(active, COPY);
    expect(mockRequestPermissions).not.toHaveBeenCalled();
  });
});

describe('getPracticeReminderPermission', () => {
  it('maps prompt-with-rationale to prompt (still askable)', async () => {
    mockCheckPermissions.mockResolvedValue({ display: 'prompt-with-rationale' });
    expect(await getPracticeReminderPermission()).toBe('prompt');
  });
  it('passes through granted/denied', async () => {
    mockCheckPermissions.mockResolvedValue({ display: 'granted' });
    expect(await getPracticeReminderPermission()).toBe('granted');
    mockCheckPermissions.mockResolvedValue({ display: 'denied' });
    expect(await getPracticeReminderPermission()).toBe('denied');
  });
});
