import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useSubscriptionStatus } from '../hooks/useSubscriptionStatus';
import { resolveSubscriptionUiState } from '../domain/subscription/resolve-subscription-ui-state';
import { ENTITLEMENT_MESSAGES } from '../domain/entitlements/entitlement-messages';

interface Props {
  /** Opens the plans/subscription screen — the real (native RevenueCat) purchase
   *  flow lives there, so this popup only announces + routes, never charges. */
  onNavigateToSubscription: () => void;
  /** Suppress the popup on screens where it would be redundant/stacked — chiefly
   *  the subscription screen itself. */
  suppressed?: boolean;
}

/**
 * Proactive access-ended gate. A dismissible popup that appears once the
 * authenticated user has NO valid access — the trial ran out OR a subscription
 * lapsed — offering them to subscribe to a plan.
 *
 * The "no valid access" decision is NOT re-derived here: it comes from the
 * canonical resolver `resolveSubscriptionUiState`, whose 'expired' state is the
 * single source of truth for "trial/subscription over, no access". The store
 * axis is unknown at the app shell (no native-purchase hook mounted here), so we
 * pass a `supported:false` snapshot — the resolver then collapses to backend
 * access truth (GET /api/subscription/status), which is exactly what gates
 * access. A user who just purchased on a native store is reconciled by the
 * webhook / the SubscriptionView's own /sync, so the backend converges to
 * 'active' and this popup won't fire for them.
 *
 * Shown at most once per app session: dismissing (or tapping "Ver planos")
 * closes it for the rest of the session. It re-evaluates on the next app launch.
 */
export default function SubscriptionGatePopup({ onNavigateToSubscription, suppressed }: Props) {
  const { state } = useSubscriptionStatus();
  const [dismissed, setDismissed] = useState(false);

  const uiState = state
    ? resolveSubscriptionUiState(state, {
        supported: false,
        loaded: false,
        activeEntitlementIds: [],
        managementUrl: null,
      }).subscriptionState
    : null;

  const shouldShow = uiState === 'expired' && !dismissed && !suppressed;
  if (!shouldShow) return null;

  const handleSubscribe = () => {
    setDismissed(true);
    onNavigateToSubscription();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="subscription-gate-title"
      onClick={() => setDismissed(true)}
    >
      <div
        className="w-full max-w-sm bg-slate-800 border border-slate-700 rounded-2xl p-6 space-y-4 shadow-2xl"
        style={{ paddingBottom: 'calc(1.5rem + env(safe-area-inset-bottom))' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-center space-y-2">
          <div className="w-12 h-12 mx-auto rounded-full bg-blue-500/15 flex items-center justify-center">
            <Sparkles className="w-6 h-6 text-blue-400 shrink-0" strokeWidth={2} aria-hidden="true" />
          </div>
          <h2 id="subscription-gate-title" className="text-lg font-bold text-slate-100">
            {ENTITLEMENT_MESSAGES.accessEndedPopupTitle}
          </h2>
          <p className="text-sm text-slate-300 leading-relaxed">
            {ENTITLEMENT_MESSAGES.noValidAccessMessage}
          </p>
          <p className="text-xs text-slate-500 leading-relaxed">
            {ENTITLEMENT_MESSAGES.accessEndedPopupReassurance}
          </p>
        </div>

        <button
          type="button"
          onClick={handleSubscribe}
          data-testid="subscription-gate-popup-cta"
          className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 min-h-[44px]"
        >
          {ENTITLEMENT_MESSAGES.viewPlansCta}
        </button>

        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="w-full py-2.5 rounded-xl text-slate-400 hover:text-slate-200 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-slate-600"
        >
          {ENTITLEMENT_MESSAGES.accessEndedPopupDismiss}
        </button>
      </div>
    </div>
  );
}
