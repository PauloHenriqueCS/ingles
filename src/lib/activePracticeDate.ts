export function getNextActivePracticeDate(date: Date, activeWeekdays: number[]): Date {
  if (activeWeekdays.length === 0) return date;

  const candidate = new Date(date.getTime());
  for (let i = 0; i < 8; i++) {
    if (activeWeekdays.includes(candidate.getUTCDay())) return candidate;
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return candidate;
}
