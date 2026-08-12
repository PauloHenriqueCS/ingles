/** "2 gerações restantes hoje" / "1 geração restante hoje". */
export function formatDailyRemaining(remaining: number, singularNoun: string, pluralNoun: string): string {
  const n = Math.max(0, Math.floor(remaining));
  const noun = n === 1 ? singularNoun : pluralNoun;
  const suffix = n === 1 ? 'restante' : 'restantes';
  return `${n} ${noun} ${suffix} hoje`;
}

/** "8 min 32 s" / "10 min" / "45 s" / "0 s". */
export function formatSecondsAsMinSec(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const min = Math.floor(s / 60);
  const sec = s % 60;
  if (min === 0) return `${sec} s`;
  if (sec === 0) return `${min} min`;
  return `${min} min ${sec} s`;
}

/** "8 min 32 s restantes neste mês". */
export function formatMonthlyRemaining(totalSeconds: number): string {
  return `${formatSecondsAsMinSec(totalSeconds)} restantes neste mês`;
}

/** "3 min 20 s restantes em minutos extras". */
export function formatExtraMinutesRemaining(totalSeconds: number): string {
  return `${formatSecondsAsMinSec(totalSeconds)} restantes em minutos extras`;
}

/** "8 min 32 s restantes no período de teste" — trial's lifetime total (period='lifetime'), never "neste mês". */
export function formatTrialRemaining(totalSeconds: number): string {
  return `${formatSecondsAsMinSec(totalSeconds)} restantes no período de teste`;
}

/** "1830 min disponíveis" — the TOTAL usable balance (plan + purchased extra),
 *  shown when both exist so purchased minutes are never hidden. */
export function formatTotalMinutesAvailable(totalSeconds: number): string {
  return `${formatSecondsAsMinSec(totalSeconds)} disponíveis`;
}

/** "30 min do plano + 1800 min adicionais" — the breakdown line under the total. */
export function formatConversationBalanceBreakdown(planSeconds: number, extraSeconds: number): string {
  return `${formatSecondsAsMinSec(planSeconds)} do plano + ${formatSecondsAsMinSec(extraSeconds)} adicionais`;
}

/** "1800 min adicionais disponíveis" — plan exhausted, only purchased credits
 *  left. Never "restantes neste mês": extra credits aren't the monthly plan. */
export function formatExtraMinutesAvailable(extraSeconds: number): string {
  return `${formatSecondsAsMinSec(extraSeconds)} adicionais disponíveis`;
}

/** "00:12" — mm:ss clock for recording timers. */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const min = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
