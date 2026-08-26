import { useEffect } from 'react';
import { isPracticeReminderSupported } from '../lib/notifications/practiceReminderService';
import { reconcilePracticeReminders } from '../lib/notifications/practiceReminderReconcile';

/**
 * Bridges the Supabase session to the LOCAL practice-reminder schedules on the
 * device, mirroring useOneSignalIdentitySync. The preference belongs to the
 * USER (server), the notification belongs to the DEVICE — so this keeps them in
 * lockstep across login / logout / account switch (§9) and re-heals the local
 * schedules on resume in case the OS dropped them after a reinstall/restore (§8).
 *
 * All the real work (including resolving the CURRENT interfaceLanguage from the
 * official server source so the notification copy always matches the user's UI
 * language) lives in reconcilePracticeReminders — this hook only decides WHEN to
 * run it: on session change and on foreground/resume. It NEVER prompts for
 * permission (§4); first-time permission is asked only from the explicit
 * "ativar" action on the reminder screen. Safe to mount unconditionally
 * (App.tsx, once): every call is a no-op on web and idempotent.
 */
export function usePracticeReminderSync(userId: string | null | undefined): void {
  // Session change (login / logout / account switch).
  useEffect(() => {
    if (!isPracticeReminderSupported()) return;
    void reconcilePracticeReminders(userId);
  }, [userId]);

  // Foreground/resume re-heal: the OS can drop local schedules after a
  // reinstall/restore; reconciling on resume (idempotent) rebuilds them from the
  // persisted preference AND the current interface language. Registered via
  // dynamic import so @capacitor/app never enters the web bundle's eager graph.
  useEffect(() => {
    if (!isPracticeReminderSupported() || !userId) return;

    let handle: { remove: () => void } | null = null;
    let disposed = false;

    (async () => {
      try {
        const { App } = await import('@capacitor/app');
        handle = await App.addListener('appStateChange', ({ isActive }) => {
          if (isActive) void reconcilePracticeReminders(userId);
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
  }, [userId]);
}
