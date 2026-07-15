import type { DailyActivityStatus } from '../../../types';

export function resolveListeningCalendarStatus(
  assignmentStatus: 'not_started' | 'in_progress' | 'completed' | undefined,
): DailyActivityStatus {
  if (assignmentStatus === 'completed')  return 'completed';
  if (assignmentStatus === 'in_progress') return 'in_progress';
  if (assignmentStatus === 'not_started') return 'not_started';
  return 'coming_soon';
}
