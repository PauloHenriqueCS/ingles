import {
  isPracticeReminderSupported,
  syncPracticeReminders,
  cancelPracticeReminders,
  getPracticeReminderPermission,
} from './practiceReminderService';
import { buildReminderCopy } from './practiceReminderCopy';
import { fetchPracticeReminder } from '../practiceReminder';
import { getCurrentInterfaceLanguage } from '../interfaceLanguage';

/**
 * The single reconcile step "persisted preference + CURRENT interfaceLanguage →
 * localized device schedules", shared by every trigger (login, account switch,
 * app resume, reinstall-then-login). Extracted from usePracticeReminderSync so
 * the orchestration — including that the copy always follows the current
 * interface language — is unit-testable without a React renderer.
 *
 * Contract (all idempotent, native-only):
 *   - web / unsupported          → no-op
 *   - logged out (no userId)     → cancel our reserved reminders
 *   - permission not granted     → cancel (never prompt here — §4)
 *   - granted                    → fetch preference + language, then sync with
 *                                  localized copy (pt-BR only if no language)
 */
export async function reconcilePracticeReminders(
  userId: string | null | undefined,
): Promise<void> {
  if (!isPracticeReminderSupported()) return;

  if (!userId) {
    await cancelPracticeReminders();
    return;
  }

  const permission = await getPracticeReminderPermission();
  if (permission !== 'granted') {
    await cancelPracticeReminders();
    return;
  }

  const [pref, lang] = await Promise.all([
    fetchPracticeReminder(),
    getCurrentInterfaceLanguage(),
  ]);
  await syncPracticeReminders(pref, buildReminderCopy(lang));
}
