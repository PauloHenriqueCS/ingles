import { useEffect } from 'react';
import {
  isPracticeReminderSupported,
  syncPracticeReminders,
  cancelPracticeReminders,
  getPracticeReminderPermission,
  type PracticeReminderCopy,
} from '../lib/notifications/practiceReminderService';
import { fetchPracticeReminder } from '../lib/practiceReminder';
import { practiceReminderUiStrings } from '../i18n/practiceReminderUiStrings';

/**
 * Bridges the Supabase session to the LOCAL practice-reminder schedules on the
 * device, mirroring useOneSignalIdentitySync. The preference belongs to the
 * USER (server), the notification belongs to the DEVICE — so this keeps them in
 * lockstep across login / logout / account switch (§9) and re-heals the local
 * schedules on resume in case the OS dropped them after a reinstall/restore (§8).
 *
 * Deliberately NEVER prompts for permission (§4): a login/resume sync only acts
 * when permission is ALREADY granted. First-time permission is requested only
 * from the explicit "ativar" action on the reminder screen. Safe to mount
 * unconditionally (App.tsx, once): every call is a no-op on web and idempotent.
 */
export function usePracticeReminderSync(
  userId: string | null | undefined,
  interfaceLanguage?: string | null,
): void {
  useEffect(() => {
    if (!isPracticeReminderSupported()) return;

    let cancelled = false;

    async function reconcile(): Promise<void> {
      // Logged out (or logging out): the device must not keep notifying about a
      // routine that belongs to an account that just signed out. Cancel our
      // reserved reminders and stop — no preference to read.
      if (!userId) {
        await cancelPracticeReminders();
        return;
      }

      // Don't prompt on login: only act when permission already exists.
      const permission = await getPracticeReminderPermission();
      if (permission !== 'granted') {
        // No permission → make sure nothing lingers scheduled for this device.
        await cancelPracticeReminders();
        return;
      }

      const pref = await fetchPracticeReminder();
      if (cancelled) return;
      await syncPracticeReminders(pref, buildCopy(interfaceLanguage));
    }

    void reconcile();
    return () => {
      cancelled = true;
    };
  }, [userId, interfaceLanguage]);

  // Re-heal on foreground/resume: the OS can drop local schedules after a
  // reinstall/restore; reconciling on resume (idempotent) rebuilds them from the
  // persisted preference. Registered via dynamic import so @capacitor/app never
  // enters the web bundle's eager graph.
  useEffect(() => {
    if (!isPracticeReminderSupported() || !userId) return;

    let handle: { remove: () => void } | null = null;
    let disposed = false;

    (async () => {
      try {
        const { App } = await import('@capacitor/app');
        handle = await App.addListener('appStateChange', ({ isActive }) => {
          if (!isActive) return;
          void (async () => {
            const permission = await getPracticeReminderPermission();
            if (permission !== 'granted') return;
            const pref = await fetchPracticeReminder();
            await syncPracticeReminders(pref, buildCopy(interfaceLanguage));
          })();
        });
        if (disposed) handle.remove();
      } catch {
        /* @capacitor/app unavailable (web) — resume re-sync is a native nicety. */
      }
    })();

    return () => {
      disposed = true;
      handle?.remove();
    };
  }, [userId, interfaceLanguage]);
}

function buildCopy(interfaceLanguage?: string | null): PracticeReminderCopy {
  const t = practiceReminderUiStrings(interfaceLanguage);
  return { title: t.notificationTitle, body: t.notificationBody, channelName: t.title };
}
