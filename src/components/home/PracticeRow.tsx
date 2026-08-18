import { Lock, ChevronRight } from 'lucide-react';
import { ACCENTS, type AccentKey } from './accents';
import type { CardVisualState, PracticeBadge } from './practiceAvailability';

interface Props {
  accent: AccentKey;
  icon: React.ReactNode;
  title: string;
  description: string;
  state: CardVisualState;
  badge: PracticeBadge | null;
  onClick: () => void;
}

const BADGE_TONE: Record<PracticeBadge['tone'], string> = {
  positive: 'bg-emerald-900/30 border-emerald-800/40 text-emerald-300',
  warning: 'bg-amber-900/30 border-amber-800/40 text-amber-300',
  muted: 'bg-slate-700/50 border-slate-600/40 text-slate-400',
};

/**
 * Compact, full-width, single-tap practice row (the "Outras práticas" list). Far
 * shorter than the old big cards so the Home fits many activities without long
 * scrolling, while keeping a ≥44px touch target. A blocked activity shows a Lock
 * + muted badge so it never looks normally available.
 */
export default function PracticeRow({ accent, icon, title, description, state, badge, onClick }: Props) {
  const a = ACCENTS[accent];
  const blocked = state === 'disabled_by_plan' || state === 'disabled_globally';
  const dimmed = blocked || state === 'limit_reached' || state === 'loading';

  return (
    <button
      type="button"
      onClick={onClick}
      aria-disabled={state === 'loading'}
      className={`group w-full text-left flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-800/60 px-3 py-3 transition-colors duration-150 focus:outline-none focus-visible:ring-2 ${a.ring} focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 ${
        dimmed ? 'opacity-70' : 'hover:bg-slate-700/60 hover:border-slate-700'
      }`}
    >
      <div
        className={`flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br ${a.grad} shadow-md ${a.shadow} shrink-0 ${
          dimmed ? 'grayscale' : ''
        }`}
      >
        {blocked ? <Lock className="w-5 h-5 text-white shrink-0" strokeWidth={2} aria-hidden="true" /> : icon}
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-slate-100 leading-tight truncate">{title}</p>
        <p className="text-xs text-slate-400 leading-snug mt-0.5 line-clamp-2">{description}</p>
      </div>

      {badge && (
        <span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[11px] font-medium tabular-nums shrink-0 ${BADGE_TONE[badge.tone]}`}>
          {badge.label}
        </span>
      )}

      <ChevronRight className="w-5 h-5 text-slate-500 shrink-0 group-hover:text-slate-300 transition-colors" strokeWidth={2} aria-hidden="true" />
    </button>
  );
}
