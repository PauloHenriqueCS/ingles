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
import type {
  CelebrationActivityType,
  StreakCelebrationKind,
} from '../celebration/celebration-types';

export interface CelebrationUiStrings {
  /** Per-activity "<Activity> concluída" title. */
  activityTitle: (activity: CelebrationActivityType) => string;
  /** "2 de 3 práticas de hoje" progress line (only shown when counts exist). */
  activityProgress: (completed: number, total: number) => string;

  // Day complete
  dayCompleteTitle: string; // "Dia completo!"
  dayCompleteSubtitle: string; // "Você concluiu sua rotina de hoje"
  streakLine: (days: number) => string; // "Sequência: 8 dias"

  // Streak celebration (milestone / personal record / both)
  streakEyebrow: (kind: StreakCelebrationKind) => string;
  streakTitle: (kind: StreakCelebrationKind, days: number) => string;
  streakSubtitle: (kind: StreakCelebrationKind, days: number, previousBest: number) => string;
  streakAria: (kind: StreakCelebrationKind, days: number) => string;

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

function milestoneSubPt(days: number): string {
  switch (days) {
    case 3: return 'Três dias seguidos — o começo de uma rotina.';
    case 7: return 'Uma semana inteira mantendo sua rotina.';
    case 14: return 'Duas semanas seguidas de prática.';
    case 21: return 'Três semanas — já virou hábito.';
    case 30: return 'Um mês inteiro de constância.';
    case 60: return 'Dois meses sem perder o ritmo.';
    case 90: return 'Noventa dias de dedicação ao seu inglês.';
    case 100: return 'Cem dias de dedicação ao seu inglês.';
    case 180: return 'Meio ano de evolução, dia após dia.';
    case 365: return 'Um ano inteiro de evolução, dia após dia.';
    case 730: return 'Dois anos de constância. Impressionante.';
    default: return `Você manteve sua rotina por ${days} dias seguidos.`;
  }
}

const PT_BR: CelebrationUiStrings = {
  activityTitle: (a) => `${ACTIVITY_PT[a]} concluída`,
  activityProgress: (completed, total) =>
    `${completed} de ${total} ${total === 1 ? 'prática' : 'práticas'} de hoje`,
  dayCompleteTitle: 'Dia completo!',
  dayCompleteSubtitle: 'Você concluiu sua rotina de hoje',
  streakLine: (days) => `Sequência: ${days} ${days === 1 ? 'dia' : 'dias'}`,
  streakEyebrow: (kind) =>
    kind === 'both' ? 'Marco + recorde' : kind === 'personal_record' ? 'Recorde pessoal' : 'Marco de sequência',
  streakTitle: (kind, days) => {
    const d = days === 1 ? 'dia' : 'dias';
    if (kind === 'personal_record') return 'Novo recorde pessoal';
    if (kind === 'both') return `Novo recorde: ${days} ${d}!`;
    return `${days} ${d} de sequência`;
  },
  streakSubtitle: (kind, days) => {
    const d = days === 1 ? 'dia' : 'dias';
    if (kind === 'personal_record') return `Sua maior sequência agora é de ${days} ${d}.`;
    if (kind === 'both') return 'Você alcançou um novo marco e sua maior sequência até hoje.';
    return milestoneSubPt(days);
  },
  streakAria: (kind, days) => {
    const d = days === 1 ? 'dia' : 'dias';
    if (kind === 'personal_record') return `Novo recorde pessoal: ${days} ${d}.`;
    if (kind === 'both') return `Novo recorde e novo marco: ${days} ${d}.`;
    return `Marco de sequência: ${days} ${d}.`;
  },
  activityAria: (a) => `${ACTIVITY_PT[a]} concluída`,
  dayCompleteAria: 'Dia completo! Você concluiu sua rotina de hoje.',
};

function milestoneSubEn(days: number): string {
  switch (days) {
    case 3: return 'Three days in a row — a routine is forming.';
    case 7: return 'A whole week keeping your routine.';
    case 14: return 'Two weeks of practice in a row.';
    case 21: return 'Three weeks — it’s a habit now.';
    case 30: return 'A full month of consistency.';
    case 60: return 'Two months without losing your rhythm.';
    case 90: return 'Ninety days devoted to your English.';
    case 100: return 'One hundred days devoted to your English.';
    case 180: return 'Half a year of progress, day after day.';
    case 365: return 'A whole year of progress, day after day.';
    case 730: return 'Two years of consistency. Remarkable.';
    default: return `You kept your routine for ${days} days in a row.`;
  }
}

const EN: CelebrationUiStrings = {
  activityTitle: (a) => `${ACTIVITY_EN[a]} complete`,
  activityProgress: (completed, total) =>
    `${completed} of ${total} ${total === 1 ? 'practice' : 'practices'} today`,
  dayCompleteTitle: 'Day complete!',
  dayCompleteSubtitle: 'You finished your routine for today',
  streakLine: (days) => `Streak: ${days} ${days === 1 ? 'day' : 'days'}`,
  streakEyebrow: (kind) =>
    kind === 'both' ? 'Milestone + record' : kind === 'personal_record' ? 'Personal record' : 'Streak milestone',
  streakTitle: (kind, days) => {
    const d = days === 1 ? 'day' : 'days';
    if (kind === 'personal_record') return 'New personal record';
    if (kind === 'both') return `New record: ${days} ${d}!`;
    return `${days}-${d} streak`;
  },
  streakSubtitle: (kind, days) => {
    const d = days === 1 ? 'day' : 'days';
    if (kind === 'personal_record') return `Your longest streak is now ${days} ${d}.`;
    if (kind === 'both') return 'You hit a new milestone and your longest streak yet.';
    return milestoneSubEn(days);
  },
  streakAria: (kind, days) => {
    const d = days === 1 ? 'day' : 'days';
    if (kind === 'personal_record') return `New personal record: ${days} ${d}.`;
    if (kind === 'both') return `New record and new milestone: ${days} ${d}.`;
    return `Streak milestone: ${days} ${d}.`;
  },
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
