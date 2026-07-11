export type ReviewOverallResult = 'passed' | 'failed';
export type ReviewGroupStatus = 'scheduled' | 'mastered';

export interface ReviewScheduleInput {
  currentLevel: number;
  overallResult: ReviewOverallResult;
  attemptedAt: Date;
}

export interface ReviewScheduleOutput {
  newLevel: number;
  newStatus: ReviewGroupStatus;
  nextReviewAt: Date | null;
  intervalDays: number | null;
}

const PASS_INTERVAL_DAYS: Readonly<Record<number, number>> = { 0: 7, 1: 21, 2: 60 };
const FAIL_INTERVAL_DAYS = 2;
const MASTERED_LEVEL = 4;

function addDaysUTC(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

export function calculateReviewSchedule(input: ReviewScheduleInput): ReviewScheduleOutput {
  const { currentLevel, overallResult, attemptedAt } = input;

  if (overallResult === 'failed') {
    return {
      newLevel: 0,
      newStatus: 'scheduled',
      nextReviewAt: addDaysUTC(attemptedAt, FAIL_INTERVAL_DAYS),
      intervalDays: FAIL_INTERVAL_DAYS,
    };
  }

  // passed — já dominado
  if (currentLevel >= MASTERED_LEVEL) {
    return { newLevel: currentLevel, newStatus: 'mastered', nextReviewAt: null, intervalDays: null };
  }

  // passed — nível 3 → domínio
  if (currentLevel === MASTERED_LEVEL - 1) {
    return { newLevel: MASTERED_LEVEL, newStatus: 'mastered', nextReviewAt: null, intervalDays: null };
  }

  // passed — avançar nível
  const days = PASS_INTERVAL_DAYS[currentLevel] ?? FAIL_INTERVAL_DAYS;
  return {
    newLevel: currentLevel + 1,
    newStatus: 'scheduled',
    nextReviewAt: addDaysUTC(attemptedAt, days),
    intervalDays: days,
  };
}
