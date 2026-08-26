/**
 * Interface-language localization for the "Lembrete de prática" (Practice
 * reminder) screen and for the LOCAL NOTIFICATION copy it schedules — following
 * the exact pattern of homeUiStrings / curriculumUiStrings: ONE place keyed by
 * interface_language, never strings scattered across components. Falls back to
 * pt-BR (the app's primary + default interface language).
 *
 * The notification title/body live here too because the notification must speak
 * the user's UI language; the value is captured at schedule time and handed to
 * the local-notifications scheduler (which fires outside any React render).
 */
export interface PracticeReminderUiStrings {
  title: string;                       // screen title / menu label
  intro: string;                       // one-line explanation under the header
  toggleLabel: string;                 // "Lembre-me de praticar"
  toggleHint: string;                  // small helper under the toggle
  weekdaysLabel: string;               // "Dias da semana"
  timeLabel: string;                   // "Horário"
  saveButton: string;
  savingButton: string;
  savedFeedback: string;               // toast/inline after a successful save

  /** Short weekday label (chips), keyed by ISO day 1=Mon..7=Sun. */
  weekdayShort: (isoDay: number) => string;
  /** Full weekday name (aria / summary), keyed by ISO day 1=Mon..7=Sun. */
  weekdayLong: (isoDay: number) => string;

  /** Human summary shown in the menu/screen when enabled, e.g. "Seg, Qua e Sex às 19:30". */
  summaryEnabled: (daysLabel: string, time: string) => string;
  summaryDisabled: string;            // "Desativado"

  validationNeedDay: string;          // enabled but no weekday chosen
  permissionDeniedTitle: string;      // notifications blocked at OS level
  permissionDeniedBody: string;       // explain + how to re-enable in system settings
  webUnsupportedNote: string;         // shown on plain web (no native scheduling)

  notificationTitle: string;          // the scheduled notification title
  notificationBody: string;           // the scheduled notification body
}

const PT_WEEKDAYS_SHORT = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
const PT_WEEKDAYS_LONG = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'];
const EN_WEEKDAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const EN_WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** ISO day (1=Mon..7=Sun) → 0-based index, safe for out-of-range input. */
function isoIndex(isoDay: number): number {
  return Math.min(6, Math.max(0, Math.trunc(isoDay) - 1));
}

const PT_BR: PracticeReminderUiStrings = {
  title: 'Lembrete de prática',
  intro: 'Escolha os dias e o horário para o app te lembrar de praticar inglês.',
  toggleLabel: 'Lembre-me de praticar',
  toggleHint: 'Uma notificação no seu aparelho nos dias e horário escolhidos.',
  weekdaysLabel: 'Dias da semana',
  timeLabel: 'Horário',
  saveButton: 'Salvar',
  savingButton: 'Salvando…',
  savedFeedback: 'Lembrete salvo.',
  weekdayShort: (d) => PT_WEEKDAYS_SHORT[isoIndex(d)],
  weekdayLong: (d) => PT_WEEKDAYS_LONG[isoIndex(d)],
  summaryEnabled: (days, time) => `${days} às ${time}`,
  summaryDisabled: 'Desativado',
  validationNeedDay: 'Selecione pelo menos um dia da semana.',
  permissionDeniedTitle: 'Notificações desativadas',
  permissionDeniedBody:
    'As notificações estão bloqueadas para o Orodim no seu aparelho. Ative-as nas configurações do sistema para receber o lembrete.',
  webUnsupportedNote:
    'O lembrete dispara no aplicativo para celular. Aqui na web sua preferência é salva, mas a notificação só chega no app.',
  notificationTitle: 'Hora de praticar',
  notificationBody: 'Que tal continuar seu inglês hoje?',
};

const EN: PracticeReminderUiStrings = {
  title: 'Practice reminder',
  intro: 'Choose the days and time for the app to remind you to practice English.',
  toggleLabel: 'Remind me to practice',
  toggleHint: 'A notification on your device on the days and time you choose.',
  weekdaysLabel: 'Days of the week',
  timeLabel: 'Time',
  saveButton: 'Save',
  savingButton: 'Saving…',
  savedFeedback: 'Reminder saved.',
  weekdayShort: (d) => EN_WEEKDAYS_SHORT[isoIndex(d)],
  weekdayLong: (d) => EN_WEEKDAYS_LONG[isoIndex(d)],
  summaryEnabled: (days, time) => `${days} at ${time}`,
  summaryDisabled: 'Off',
  validationNeedDay: 'Select at least one day of the week.',
  permissionDeniedTitle: 'Notifications disabled',
  permissionDeniedBody:
    'Notifications are blocked for Orodim on your device. Enable them in your system settings to receive the reminder.',
  webUnsupportedNote:
    'The reminder fires in the mobile app. On the web your preference is saved, but the notification only arrives in the app.',
  notificationTitle: 'Time to practice',
  notificationBody: 'How about continuing your English practice today?',
};

const STRINGS: Record<string, PracticeReminderUiStrings> = { 'pt-BR': PT_BR, en: EN };

export function practiceReminderUiStrings(
  interfaceLanguage: string | null | undefined,
): PracticeReminderUiStrings {
  const code = (interfaceLanguage ?? '').trim();
  return STRINGS[code] ?? STRINGS[code.split('-')[0]] ?? PT_BR;
}
