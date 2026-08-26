// Type-only import (erased at compile time — does NOT pull the native bridge
// into the web bundle) so the plugin's Weekday enum can type the mapped value.
import type { Weekday } from '@capacitor/local-notifications';
import { isIOSApp, isAndroidApp, isPluginAvailable } from '../runtimeEnvironment';
import {
  PRACTICE_REMINDER_IDS,
  isActionable,
  isoToPluginWeekday,
  normalizeWeekdays,
  practiceReminderIdForIsoDay,
  type PracticeReminderPreference,
} from '../../domain/practiceReminder/practiceReminder';

/**
 * SINGLE entry point to @capacitor/local-notifications — no other file may
 * import that package directly. Scheduling the Practice Reminder is a NATIVE-only
 * concern: the plugin bridge exists only inside the Android/iOS Capacitor shell.
 * This app is remote-first (the WebView loads app.orodim.com.br — see
 * capacitor.config.ts), so this module rides in the deployed web bundle and
 * calls the native bridge the same way onesignalClient.ts does. On the plain web
 * every function below is an inert no-op and the SDK is never even imported.
 *
 * Idempotency: reminders use DETERMINISTIC ids (PRACTICE_REMINDER_ID_BASE + ISO
 * weekday), so re-saving the same config overwrites the same slots and we cancel
 * EXACTLY our own reminders (this reserved range only) — never another feature's
 * notifications (OneSignal push does not use LocalNotifications at all).
 *
 * Time semantics: the plugin's `schedule.on = { weekday, hour, minute }` matches
 * against the DEVICE's local calendar, repeating weekly — exactly "19:30 no
 * horário local", with no UTC conversion. If the user changes timezone, the same
 * wall-clock time still fires.
 */

const PLUGIN_NAME = 'LocalNotifications';
const CHANNEL_ID = 'practice-reminders';

export type NotificationPermission = 'granted' | 'denied' | 'prompt';

export interface PracticeReminderCopy {
  title: string;
  body: string;
  /** Android notification channel display name (localized). */
  channelName: string;
}

export interface SyncResult {
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
  scheduled: boolean;
  /** Number of weekly reminders scheduled (0 when cancelled/blocked). */
  count: number;
}

/** Sanitized tap payload handed to the app router. */
export interface ReminderTapPayload {
  id: number;
}

export function isPracticeReminderSupported(): boolean {
  return (isIOSApp || isAndroidApp) && isPluginAvailable(PLUGIN_NAME);
}

// Lazy/dynamic import so the native bridge module is never evaluated in the web
// bundle's eager graph — isPracticeReminderSupported() guards every call site.
async function loadPlugin() {
  const mod = await import('@capacitor/local-notifications');
  return mod.LocalNotifications;
}

let channelReady = false;
let tapListenerRegistered = false;
let tapHandler: ((payload: ReminderTapPayload) => void) | null = null;
// Serializes schedule/cancel so a fast save→save (or logout during a save)
// can't interleave two overlapping mutations of the same reserved id range.
let opChain: Promise<void> = Promise.resolve();

/** Register (or clear with null) the single app-level handler for reminder taps. */
export function setPracticeReminderTapHandler(
  handler: ((payload: ReminderTapPayload) => void) | null,
): void {
  tapHandler = handler;
}

/**
 * Register the native tap listener early (idempotent), independent of any
 * schedule. Call once at app boot so a tap that cold-starts the app is caught
 * as soon as the app-level handler is set. No-op on web.
 */
export async function ensurePracticeReminderListeners(): Promise<void> {
  await ensureTapListener();
}

function mapPermission(display: string | undefined): NotificationPermission {
  if (display === 'granted') return 'granted';
  if (display === 'denied') return 'denied';
  // 'prompt' | 'prompt-with-rationale' | undefined → still askable.
  return 'prompt';
}

/** Current OS permission WITHOUT prompting. 'unsupported' off-device. */
export async function getPracticeReminderPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!isPracticeReminderSupported()) return 'unsupported';
  try {
    const plugin = await loadPlugin();
    const res = await plugin.checkPermissions();
    return mapPermission(res.display);
  } catch {
    return 'denied';
  }
}

/** Prompt for permission (only call from an explicit user action). */
export async function requestPracticeReminderPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!isPracticeReminderSupported()) return 'unsupported';
  try {
    const plugin = await loadPlugin();
    const res = await plugin.requestPermissions();
    return mapPermission(res.display);
  } catch {
    return 'denied';
  }
}

async function ensureChannel(copy: PracticeReminderCopy): Promise<void> {
  // Channels are an Android concept; iOS has no channels. createChannel is a
  // no-op we simply skip off-Android. Recreating an existing channel is safe.
  if (!isAndroidApp) return;
  try {
    const plugin = await loadPlugin();
    await plugin.createChannel({
      id: CHANNEL_ID,
      name: copy.channelName,
      description: copy.channelName,
      importance: 4, // IMPORTANCE_HIGH — shows a heads-up reminder.
      visibility: 1, // VISIBILITY_PUBLIC
    });
    channelReady = true;
  } catch {
    // Non-fatal: scheduling still works on the default channel.
  }
}

async function ensureTapListener(): Promise<void> {
  if (tapListenerRegistered || !isPracticeReminderSupported()) return;
  tapListenerRegistered = true;
  try {
    const plugin = await loadPlugin();
    await plugin.addListener('localNotificationActionPerformed', (event: unknown) => {
      const id = extractTapId(event);
      if (id != null && tapHandler) tapHandler({ id });
    });
  } catch {
    tapListenerRegistered = false; // allow a later retry
  }
}

function extractTapId(event: unknown): number | null {
  const e = (event ?? {}) as { notification?: { id?: unknown } };
  const raw = e.notification?.id;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Cancel EXACTLY this feature's reserved reminders (never other features'). */
export async function cancelPracticeReminders(): Promise<void> {
  if (!isPracticeReminderSupported()) return;
  opChain = opChain.then(async () => {
    try {
      const plugin = await loadPlugin();
      // Cancel the full reserved id range regardless of which are currently set
      // — cancelling a non-pending id is a safe no-op — so any prior config is
      // fully cleared. Belt-and-suspenders: also sweep pending in our range in
      // case an older build used a different subset.
      const ids = new Set<number>(PRACTICE_REMINDER_IDS);
      try {
        const pending = await plugin.getPending();
        for (const n of pending.notifications ?? []) {
          if (typeof n.id === 'number' && PRACTICE_REMINDER_IDS.includes(n.id)) ids.add(n.id);
        }
      } catch {
        /* getPending unavailable — the static reserved list still covers us. */
      }
      await plugin.cancel({ notifications: [...ids].map((id) => ({ id })) });
    } catch {
      /* off-device / plugin error — nothing to cancel. */
    }
  });
  return opChain;
}

/**
 * Schedule one weekly reminder per selected weekday, after clearing our reserved
 * range. Assumes permission is already granted (callers check). Idempotent.
 */
export async function schedulePracticeReminders(
  pref: PracticeReminderPreference,
  copy: PracticeReminderCopy,
): Promise<number> {
  if (!isPracticeReminderSupported()) return 0;
  const weekdays = normalizeWeekdays(pref.weekdays);
  if (weekdays.length === 0) {
    await cancelPracticeReminders();
    return 0;
  }

  await ensureChannel(copy);
  await ensureTapListener();

  let count = 0;
  opChain = opChain.then(async () => {
    try {
      const plugin = await loadPlugin();
      // Clear our whole reserved range first so days that were de-selected can
      // never linger (the cancel is scoped to our ids only).
      await plugin.cancel({
        notifications: PRACTICE_REMINDER_IDS.map((id) => ({ id })),
      });

      const notifications = weekdays.map((isoDay) => ({
        id: practiceReminderIdForIsoDay(isoDay),
        title: copy.title,
        body: copy.body,
        channelId: CHANNEL_ID,
        smallIcon: 'ic_stat_onesignal_default',
        schedule: {
          on: {
            weekday: isoToPluginWeekday(isoDay) as Weekday,
            hour: pref.hour,
            minute: pref.minute,
          },
          // A practice reminder tolerates the OS batching it by a few minutes,
          // so it is scheduled as an INEXACT alarm. Set explicitly (the plugin
          // defaults isExactNotification to TRUE) so we never require the
          // SCHEDULE_EXACT_ALARM special-access permission, never open the
          // "Alarms & reminders" screen, and stay Play-policy clean. allowWhileIdle
          // is kept: it lets the inexact alarm still fire during Doze maintenance
          // windows and needs no special permission.
          allowWhileIdle: true,
          isExactNotification: false,
        },
      }));
      await plugin.schedule({ notifications });
      count = notifications.length;
    } catch {
      count = 0;
    }
  });
  await opChain;
  return count;
}

/**
 * Reconcile persisted preference → device schedules. The safe, idempotent entry
 * point used by the login/resume sync and after saving:
 *   - not supported (web)           → no-op
 *   - permission not granted        → cancel (never pretend it works), don't prompt
 *   - actionable (enabled + ≥1 day) → (re)schedule
 *   - disabled / no days            → cancel our reserved range
 */
export async function syncPracticeReminders(
  pref: PracticeReminderPreference,
  copy: PracticeReminderCopy,
): Promise<SyncResult> {
  if (!isPracticeReminderSupported()) {
    return { supported: false, permission: 'unsupported', scheduled: false, count: 0 };
  }

  const permission = await getPracticeReminderPermission();
  if (permission !== 'granted') {
    await cancelPracticeReminders();
    return { supported: true, permission, scheduled: false, count: 0 };
  }

  if (!isActionable(pref)) {
    await cancelPracticeReminders();
    return { supported: true, permission, scheduled: false, count: 0 };
  }

  const count = await schedulePracticeReminders(pref, copy);
  return { supported: true, permission, scheduled: count > 0, count };
}

/** Test-only: reset module-level state between vitest cases. */
export function __resetPracticeReminderServiceForTests(): void {
  channelReady = false;
  tapListenerRegistered = false;
  tapHandler = null;
  opChain = Promise.resolve();
}

export const __internals = { CHANNEL_ID, PLUGIN_NAME, get channelReady() { return channelReady; } };
