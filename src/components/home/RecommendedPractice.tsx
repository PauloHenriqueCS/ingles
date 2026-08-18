import { Lock, Sparkles, ArrowRight } from 'lucide-react';
import { ACCENTS, type AccentKey } from './accents';
import type { CardVisualState } from './practiceAvailability';

interface Props {
  accent: AccentKey;
  icon: React.ReactNode;
  title: string;
  description: string;
  cta: string;
  state: CardVisualState;
  /** Honest "Recommended" badge — shown only when the activity is actually
   *  startable (available). Hidden when the hero is a blocked/exhausted
   *  fallback, so we never call something "recommended" the user can't begin. */
  badgeLabel: string | null;
  /** Localized badge shown instead when the hero is exhausted/blocked. */
  stateBadge: string | null;
  onClick: () => void;
}

/**
 * The prominent "Próxima recomendação" hero card. Visually dominant (accent-
 * tinted fill, accent border, larger icon, filled CTA) so it clearly outweighs
 * the compact rows below. Falls back gracefully when the recommended activity is
 * blocked: it shows a Lock + the real state badge instead of "Recommended".
 */
export default function RecommendedPractice({
  accent, icon, title, description, cta, state, badgeLabel, stateBadge, onClick,
}: Props) {
  const a = ACCENTS[accent];
  const blocked = state === 'disabled_by_plan' || state === 'disabled_globally';
  const dimmed = blocked || state === 'limit_reached' || state === 'loading';

  return (
    <button
      type="button"
      onClick={onClick}
      aria-disabled={state === 'loading'}
      className={`group w-full text-left rounded-2xl border bg-gradient-to-br ${a.heroBg} ${
        dimmed ? 'border-slate-700' : a.heroBorder
      } p-5 transition-all duration-200 focus:outline-none focus-visible:ring-2 ${a.ring} focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 ${
        dimmed ? '' : 'hover:brightness-110'
      }`}
    >
      <div className="flex items-start gap-4">
        <div
          className={`flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br ${a.grad} shadow-lg ${a.shadow} shrink-0 ${
            dimmed ? 'grayscale' : ''
          }`}
        >
          {blocked ? <Lock className="w-6 h-6 text-white shrink-0" strokeWidth={2} aria-hidden="true" /> : icon}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-bold text-slate-50 leading-snug break-words">{title}</h3>
          <p className="text-sm text-slate-300/90 leading-relaxed mt-1 break-words">{description}</p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 mt-4">
        {stateBadge ? (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-900/40 border border-amber-800/40 text-amber-300 text-xs font-medium">
            {stateBadge}
          </span>
        ) : badgeLabel ? (
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-900/40 border border-slate-700 text-xs font-medium ${a.text}`}>
            <Sparkles className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
            {badgeLabel}
          </span>
        ) : <span />}

        <span className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-white text-slate-900 text-sm font-semibold shrink-0 group-hover:bg-slate-100 transition-colors">
          {cta}
          <ArrowRight className="w-4 h-4 shrink-0" strokeWidth={2.5} aria-hidden="true" />
        </span>
      </div>
    </button>
  );
}
