/**
 * PT-BR copy for the streak celebration PREVIEW (dev-only, EXAMPLE text).
 *
 * These strings are NOT final — they exist so we can evaluate the experience.
 * The real system would move them into `src/i18n/` next to `celebrationUiStrings`
 * once a direction is chosen. All numbers are parameterized (never hardcoded).
 */
import type { StreakCelebrationType } from './streakCelebrationTypes';

export interface StreakCopy {
  /** Small eyebrow/tag above the title (e.g. "Marco de sequência"). */
  eyebrow: string;
  title: string;
  subtitle: string;
  /** Accessible announcement for screen readers. */
  aria: string;
}

/** Nice per-milestone subtitles, with a generic fallback for any other value. */
function milestoneSubtitle(days: number): string {
  switch (days) {
    case 7:
      return 'Uma semana inteira mantendo sua rotina.';
    case 14:
      return 'Duas semanas seguidas de prática.';
    case 30:
      return 'Um mês inteiro de constância.';
    case 60:
      return 'Dois meses sem perder o ritmo.';
    case 100:
      return 'Cem dias de dedicação ao seu inglês.';
    case 365:
      return 'Um ano inteiro de evolução, dia após dia.';
    default:
      return `Você manteve sua rotina por ${days} dias seguidos.`;
  }
}

/**
 * Build the copy for a given situation. `days` is the streak length being
 * celebrated; `previousBest` is only used to give the record copy context.
 */
export function streakCopy(
  type: StreakCelebrationType,
  days: number,
  previousBest?: number,
): StreakCopy {
  const dayWord = (n: number) => (n === 1 ? 'dia' : 'dias');

  switch (type) {
    case 'milestone':
      return {
        eyebrow: 'Marco de sequência',
        title: `${days} ${dayWord(days)} de sequência`,
        subtitle: milestoneSubtitle(days),
        aria: `Marco de sequência: ${days} ${dayWord(days)} de prática.`,
      };

    case 'personal_record':
      return {
        eyebrow: 'Recorde pessoal',
        title: 'Novo recorde pessoal',
        subtitle: `Sua maior sequência agora é de ${days} ${dayWord(days)}.`,
        aria: `Novo recorde pessoal: ${days} ${dayWord(days)}.`,
      };

    case 'both':
    default: {
      const prev =
        typeof previousBest === 'number' && previousBest > 0
          ? ` Antes eram ${previousBest} ${dayWord(previousBest)}.`
          : '';
      return {
        eyebrow: 'Marco + recorde',
        title: `Novo recorde: ${days} ${dayWord(days)}!`,
        subtitle: `Você alcançou um novo marco e sua maior sequência até hoje.${prev}`,
        aria: `Novo recorde e novo marco: ${days} ${dayWord(days)}.`,
      };
    }
  }
}
