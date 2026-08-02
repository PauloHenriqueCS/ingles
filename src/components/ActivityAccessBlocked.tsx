import { Lock } from 'lucide-react';
import { ENTITLEMENT_MESSAGES } from '../domain/entitlements/entitlement-messages';

interface Props {
  message?: string;
  onSubscribe: () => void;
  /** Banner form for a screen that must stay otherwise usable (e.g. DayView,
   *  which also shows past entries — history must never be hidden). Full
   *  form replaces the whole activity screen. */
  compact?: boolean;
}

/**
 * Shown when the resolved subscription/trial grants no valid access to an
 * activity right now — never rendered while entitlements are still loading
 * (callers gate on that themselves, same rule as the Home cards). The one
 * place this "no access, go to subscription" treatment is defined, reused by
 * every activity screen so the message and CTA never drift between them.
 */
export default function ActivityAccessBlocked({ message, onSubscribe, compact = false }: Props) {
  const text = message ?? ENTITLEMENT_MESSAGES.noValidAccessMessage;

  if (compact) {
    return (
      <div className="bg-amber-900/20 border border-amber-800/40 rounded-xl p-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Lock className="w-4 h-4 text-amber-400 shrink-0" strokeWidth={2} aria-hidden="true" />
          <p className="text-sm text-amber-200 leading-snug">{text}</p>
        </div>
        <button
          type="button"
          onClick={onSubscribe}
          className="shrink-0 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold transition-colors"
        >
          {ENTITLEMENT_MESSAGES.viewPlansCta}
        </button>
      </div>
    );
  }

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-2xl p-8 text-center space-y-4">
      <div className="w-14 h-14 rounded-full bg-amber-900/20 border border-amber-700/30 flex items-center justify-center mx-auto">
        <Lock className="w-7 h-7 text-amber-400" strokeWidth={2} aria-hidden="true" />
      </div>
      <p className="text-sm text-slate-300 leading-relaxed">{text}</p>
      <button
        type="button"
        onClick={onSubscribe}
        className="w-full py-3 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-semibold text-sm transition-colors"
      >
        {ENTITLEMENT_MESSAGES.viewPlansCta}
      </button>
    </div>
  );
}
