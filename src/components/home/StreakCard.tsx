import { Flame } from 'lucide-react';
import type { HomeUiStrings } from '../../i18n/homeUiStrings';

interface Props {
  /** Consecutive practice days ending today. null while loading. */
  streak: number | null;
  /** All-time longest streak (personal best). null while loading. */
  best?: number | null;
  loading: boolean;
  s: HomeUiStrings;
}

/**
 * Compact streak card (top-right of the Home header). Shows the REAL current
 * streak from the canonical calculator — never a fabricated number. The circular
 * emblem is decorative (a flame + count), NOT a progress meter: the streak is
 * open-ended, so we never imply a target/goal the user is filling toward
 * (avoids inventing gamification). Zero-state shows "0 dias" + a gentle nudge.
 */
export default function StreakCard({ streak, best, loading, s }: Props) {
  const n = streak ?? 0;
  const b = best ?? 0;
  const hasStreak = !loading && n > 0;
  const showBest = !loading && b > 0;
  const value = loading ? s.loadingShort : String(n);

  return (
    <div
      className="shrink-0 w-32 sm:w-40 rounded-2xl border border-slate-700 bg-gradient-to-br from-slate-800 to-slate-800/40 p-3 sm:p-4 flex flex-col items-center text-center"
      role="group"
      aria-label={loading ? s.streakLabel : s.streakAria(n)}
    >
      <div
        className={`relative flex items-center justify-center w-[72px] h-[72px] sm:w-20 sm:h-20 rounded-full border-2 ${
          hasStreak ? 'border-emerald-500/60' : 'border-slate-600/60'
        }`}
      >
        <Flame
          className={`absolute -top-1.5 w-4 h-4 ${hasStreak ? 'text-emerald-400' : 'text-slate-500'}`}
          strokeWidth={2}
          aria-hidden="true"
          fill={hasStreak ? 'currentColor' : 'none'}
        />
        <div className="flex flex-col items-center leading-none">
          <span className={`text-2xl font-bold tabular-nums ${hasStreak ? 'text-slate-50' : 'text-slate-300'}`}>
            {value}
          </span>
          <span className="text-[10px] text-slate-400 mt-0.5">{s.streakUnit(n)}</span>
        </div>
      </div>

      <p className="text-xs font-medium text-slate-200 mt-2 leading-tight">{s.streakLabel}</p>
      <p className={`text-[11px] mt-0.5 leading-tight ${hasStreak ? 'text-emerald-400' : 'text-slate-500'}`}>
        {hasStreak ? s.streakEncouragement : s.streakZeroHint}
      </p>
      {showBest && (
        <p className="text-[10px] text-slate-500 mt-1 leading-tight">{s.streakBest(b)}</p>
      )}
    </div>
  );
}
