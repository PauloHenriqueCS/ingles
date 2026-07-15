import type { DailyActivityStatus } from '../../../types';
import { resolveListeningCalendarStatus } from './resolve-listening-calendar-status';

type ListeningCalendarEntry = {
  date: string;
  listeningStatus: DailyActivityStatus;
};

export function buildListeningCalendarActivity(
  date: string,
  assignmentStatus: 'not_started' | 'in_progress' | 'completed' | undefined,
): ListeningCalendarEntry {
  return {
    date,
    listeningStatus: resolveListeningCalendarStatus(assignmentStatus),
  };
}
