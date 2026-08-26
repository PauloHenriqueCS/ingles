import { practiceReminderUiStrings } from '../../i18n/practiceReminderUiStrings';
import type { PracticeReminderCopy } from './practiceReminderService';

/**
 * The SINGLE place that turns an interface language into the localized notification
 * copy (title/body) + Android channel name. Both the save flow (PracticeReminderView)
 * and the login/resume re-sync (usePracticeReminderSync) call this, so the scheduler
 * always receives already-localized content and no strings live in the scheduler.
 * Language resolution/fallback lives entirely in practiceReminderUiStrings (falls
 * back to pt-BR only when no valid language resolves).
 */
export function buildReminderCopy(
  interfaceLanguage: string | null | undefined,
): PracticeReminderCopy {
  const t = practiceReminderUiStrings(interfaceLanguage);
  return { title: t.notificationTitle, body: t.notificationBody, channelName: t.title };
}
