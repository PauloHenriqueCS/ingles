/**
 * Interface-language localization for the activity-completion CELEBRATION overlay
 * — following the exact pattern of homeUiStrings/curriculumUiStrings: ONE place
 * keyed by interface_language, never strings scattered across components. The
 * interface language comes from the same server-resolved source the Home uses
 * (curriculum progress payload → interfaceLanguage). Falls back to pt-BR.
 *
 * Scope: presentation chrome only (titles, activity names, progress line, day
 * complete copy). Real numbers (streak, X of Y) are injected, never hardcoded.
 */
import type { CelebrationActivityType } from '../celebration/celebration-types';

export interface CelebrationUiStrings {
  /** Per-activity "<Activity> concluída" title. */
  activityTitle: (activity: CelebrationActivityType) => string;
  /** "2 de 3 práticas de hoje" progress line (only shown when counts exist). */
  activityProgress: (completed: number, total: number) => string;

  // Day complete
  dayCompleteTitle: string; // "Dia completo!"
  dayCompleteSubtitle: string; // "Você concluiu sua rotina de hoje"
  streakLine: (days: number) => string; // "Sequência: 8 dias"

  /** Accessible label announced when a celebration appears. */
  activityAria: (activity: CelebrationActivityType) => string;
  dayCompleteAria: string;
}

const ACTIVITY_PT: Record<CelebrationActivityType, string> = {
  writing: 'Escrita',
  listening: 'Listening',
  pronunciation: 'Pronúncia',
  conversation: 'Conversação',
  review: 'Revisão',
};

const ACTIVITY_EN: Record<CelebrationActivityType, string> = {
  writing: 'Writing',
  listening: 'Listening',
  pronunciation: 'Pronunciation',
  conversation: 'Conversation',
  review: 'Review',
};

const PT_BR: CelebrationUiStrings = {
  activityTitle: (a) => `${ACTIVITY_PT[a]} concluída`,
  activityProgress: (completed, total) =>
    `${completed} de ${total} ${total === 1 ? 'prática' : 'práticas'} de hoje`,
  dayCompleteTitle: 'Dia completo!',
  dayCompleteSubtitle: 'Você concluiu sua rotina de hoje',
  streakLine: (days) => `Sequência: ${days} ${days === 1 ? 'dia' : 'dias'}`,
  activityAria: (a) => `${ACTIVITY_PT[a]} concluída`,
  dayCompleteAria: 'Dia completo! Você concluiu sua rotina de hoje.',
};

const EN: CelebrationUiStrings = {
  activityTitle: (a) => `${ACTIVITY_EN[a]} complete`,
  activityProgress: (completed, total) =>
    `${completed} of ${total} ${total === 1 ? 'practice' : 'practices'} today`,
  dayCompleteTitle: 'Day complete!',
  dayCompleteSubtitle: 'You finished your routine for today',
  streakLine: (days) => `Streak: ${days} ${days === 1 ? 'day' : 'days'}`,
  activityAria: (a) => `${ACTIVITY_EN[a]} complete`,
  dayCompleteAria: 'Day complete! You finished your routine for today.',
};

const STRINGS: Record<string, CelebrationUiStrings> = { 'pt-BR': PT_BR, en: EN };

export function celebrationUiStrings(
  interfaceLanguage: string | null | undefined,
): CelebrationUiStrings {
  const code = interfaceLanguage ?? 'pt-BR';
  return STRINGS[code] ?? STRINGS[code.split('-')[0]] ?? PT_BR;
}
