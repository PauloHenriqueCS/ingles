import { useState } from 'react';
import { ArrowLeft, Clock, CheckCircle2, AlertTriangle, Ban, CreditCard, RotateCcw, Settings2, ExternalLink } from 'lucide-react';
import { AppIcon } from './AppIcon';
import SubscriptionPlanCard from './SubscriptionPlanCard';
import type { CommercialPlanDisplay, SubscriptionAccessStatus } from '../domain/subscription/subscription-types';
import { COMMERCIAL_PLAN_ORDER, COMMERCIAL_PLANS, RECOMMENDED_PLAN_CODE, TRIAL_DAILY_LIMITS } from '../domain/subscription/subscription-plans';
import { SUBSCRIPTION_MESSAGES, TRIAL_LIMIT_LABELS } from '../domain/subscription/subscription-copy';
import { getMockSubscriptionState, MOCK_STATUS_OPTIONS } from '../domain/subscription/subscription-mock-data';
import { buildSubscriptionViewModel } from '../domain/subscription/subscription-view-model';
import { useSubscriptionStatus } from '../hooks/useSubscriptionStatus';
import { useNativeSubscriptionPurchase } from '../hooks/useNativeSubscriptionPurchase';
import { REVENUECAT_SUBSCRIPTION_PRODUCT_IDS, type OrodimCommercialPlanCode } from '../domain/subscription/revenuecat-catalog';

interface Props {
  onBack: () => void;
  /** Testing/dev only — which mock state to render initially. When set, this
   *  overrides the real fetched status for the whole session (see the DEV
   *  switcher below); leave unset in production. */
  initialStatus?: SubscriptionAccessStatus;
}

const STATUS_ICON = {
  trialing: Clock,
  active: CheckCircle2,
  expired: AlertTriangle,
  canceled: Ban,
  billing_issue: CreditCard,
} as const;

const STATUS_SWITCHER_LABEL: Record<SubscriptionAccessStatus, string> = {
  trialing: 'Teste ativo',
  active: 'Ativa',
  expired: 'Expirado',
  canceled: 'Cancelada',
  billing_issue: 'Problema no pagamento',
};

/** CommercialPlanDisplay.code is English ('essential'/'plus' — legacy
 *  display-layer naming, pre-existing); plans.apple_product_id is keyed by
 *  the real DB plan_code ('essencial'/'plus', Portuguese — see
 *  revenuecat-catalog.ts). This is the one place that bridges them for a
 *  purchase call — never conflate the two elsewhere. */
const DISPLAY_CODE_TO_DB_PLAN_CODE: Record<CommercialPlanDisplay['code'], OrodimCommercialPlanCode> = {
  essential: 'essencial',
  plus: 'plus',
};

export default function SubscriptionView({ onBack, initialStatus }: Props) {
  const [mockOverride, setMockOverride] = useState<SubscriptionAccessStatus | null>(initialStatus ?? null);
  const { state: fetchedState, error, refetch } = useSubscriptionStatus();
  const state = mockOverride ? getMockSubscriptionState(mockOverride) : fetchedState;
  const vm = state ? buildSubscriptionViewModel(state) : null;
  const StatusIcon = vm ? STATUS_ICON[vm.status] : Clock;
  const nativePurchase = useNativeSubscriptionPurchase();

  // FASE 3/4: never offered to the internal plan or during trial — only a
  // real commercial assignment (active/canceled/billing_issue) or no
  // assignment at all (choosing a first plan) makes sense to restore/manage.
  const nativeStoreActionsAllowed = state != null && state.accessType !== 'internal' && state.accessType !== 'trial';

  async function handleSubscribe(plan: CommercialPlanDisplay) {
    if (!nativePurchase.supported) {
      // FASE 7: the website never sells subscriptions — no checkout, no
      // store call, just an honest explanation.
      window.alert(SUBSCRIPTION_MESSAGES.webPurchaseUnavailableNote);
      return;
    }
    const productId = REVENUECAT_SUBSCRIPTION_PRODUCT_IDS[DISPLAY_CODE_TO_DB_PLAN_CODE[plan.code]];
    const purchased = await nativePurchase.purchase(productId);
    if (purchased) {
      await refetch({ sync: true }); // reconcile with the backend for real, never optimistic-only
    } else if (nativePurchase.lastError && nativePurchase.lastError.code !== 'user_cancelled') {
      // user_cancelled is never presented as an alarming error (FASE 6).
      window.alert(nativePurchase.lastError.message);
    }
  }

  async function handleRestore() {
    if (!nativePurchase.supported) return; // button only ever renders when supported — see below
    const restored = await nativePurchase.restore();
    if (restored) {
      await refetch({ sync: true });
    } else if (nativePurchase.lastError) {
      window.alert(
        nativePurchase.lastError.code === 'user_cancelled'
          ? SUBSCRIPTION_MESSAGES.restoreNoneFoundNote
          : nativePurchase.lastError.message,
      );
    } else {
      window.alert(SUBSCRIPTION_MESSAGES.restoreNoneFoundNote);
    }
  }

  function handleNativeManage() {
    if (!nativePurchase.managementUrl) return; // button only ever renders when a real URL exists — see below
    window.open(nativePurchase.managementUrl, '_blank', 'noopener,noreferrer');
  }

  // Legacy handlers for the backend-capability-gated buttons further below
  // (vm.showManageButton/showRestoreButton, driven by
  // state.canManageSubscription/canRestorePurchases — both hardcoded false
  // server-side today, see subscription-status-service.ts, so these never
  // actually render yet). Kept as honest placeholders, never wired to the
  // real native flow above.
  function handleLegacyRestore() {
    window.alert(SUBSCRIPTION_MESSAGES.devRestorePlaceholder);
  }

  function handleLegacyManage() {
    window.alert(SUBSCRIPTION_MESSAGES.devManageSubscriptionPlaceholder);
  }

  const header = (
    <header className="sticky top-0 bg-slate-800 border-b border-slate-700 px-4 py-3 z-10 flex items-center gap-3">
      <button
        onClick={onBack}
        className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors"
        aria-label="Voltar"
      >
        <AppIcon icon={ArrowLeft} className="w-4 h-4 shrink-0" />
      </button>
      <h1 className="text-base font-semibold text-slate-100">Assinatura</h1>
    </header>
  );

  if (!vm) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col">
        {header}
        <div className="flex-1 flex items-center justify-center p-4">
          <p className={`text-sm ${error ? 'text-red-400' : 'text-slate-400'}`}>
            {error ? SUBSCRIPTION_MESSAGES.statusLoadError : SUBSCRIPTION_MESSAGES.statusLoading}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      {header}

      <div className="flex-1 overflow-auto p-4 max-w-2xl mx-auto w-full space-y-5 pb-10">

        {import.meta.env.DEV && (
          <section className="bg-amber-950/20 border border-amber-900/40 rounded-xl p-3 space-y-2" data-testid="dev-status-switcher">
            <p className="text-xs text-amber-300 font-medium uppercase tracking-wider">Desenvolvimento — visualizar estado</p>
            <div className="flex flex-wrap gap-2">
              {MOCK_STATUS_OPTIONS.map((status) => (
                <button
                  key={status}
                  type="button"
                  onClick={() => setMockOverride(status)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    status === mockOverride
                      ? 'bg-amber-600 text-white'
                      : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200'
                  }`}
                >
                  {STATUS_SWITCHER_LABEL[status]}
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="bg-slate-800 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <AppIcon icon={StatusIcon} className="w-5 h-5 text-blue-400 shrink-0" />
            <h2 className="text-base font-semibold text-slate-100">{vm.headline}</h2>
          </div>

          {vm.subheadline && <p className="text-sm text-slate-400 leading-relaxed">{vm.subheadline}</p>}

          {vm.status === 'trialing' && (
            <div className="space-y-1">
              <p className="text-sm text-slate-300">{vm.trialDaysRemainingLabel}</p>
              {vm.trialEndsAtLabel && (
                <p className="text-xs text-slate-500">Termina em {vm.trialEndsAtLabel}</p>
              )}
              <p className="text-xs text-slate-500">{SUBSCRIPTION_MESSAGES.trialDurationNote}</p>
            </div>
          )}

          {vm.status === 'active' && (
            <div className="space-y-1">
              <p className="text-sm text-slate-300">Plano atual: <span className="font-medium text-slate-100">{vm.currentPlanName}</span></p>
              <p className="text-xs text-emerald-400 font-medium">{vm.activeStatusLabel}</p>
              {/* Omitted entirely (never an "unavailable" placeholder) when
                  there is no real renewal date — always the case for the
                  internal unlimited plan, which has no renewal at all. */}
              {vm.renewalLabel && (
                <p className="text-xs text-slate-500">Próxima renovação: {vm.renewalLabel}</p>
              )}
            </div>
          )}

          {vm.status === 'canceled' && (
            <div className="space-y-1">
              {vm.canceledPlanName && (
                <p className="text-sm text-slate-300">Plano anterior: <span className="font-medium text-slate-100">{vm.canceledPlanName}</span></p>
              )}
              <p className="text-xs text-slate-500">Acesso até: {vm.accessEndsAtLabel}</p>
            </div>
          )}

          {vm.status === 'billing_issue' && (
            <div className="space-y-1">
              {vm.currentPlanName && (
                <p className="text-sm text-slate-300">Plano atual: <span className="font-medium text-slate-100">{vm.currentPlanName}</span></p>
              )}
              {vm.accessEndsAtLabel && (
                <p className="text-xs text-slate-500">{SUBSCRIPTION_MESSAGES.billingIssueAccessUntilNote} {vm.accessEndsAtLabel}</p>
              )}
            </div>
          )}
        </section>

        {vm.showTrialLimits && (
          <section className="bg-slate-800 rounded-xl p-5 space-y-3">
            <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">{SUBSCRIPTION_MESSAGES.trialLimitsIntro}</p>
            <ul className="space-y-1.5 text-sm text-slate-300">
              <li>{TRIAL_LIMIT_LABELS.writingPerDay(TRIAL_DAILY_LIMITS.writingPerDay)}</li>
              <li>{TRIAL_LIMIT_LABELS.pronunciationPerDay(TRIAL_DAILY_LIMITS.pronunciationPerDay)}</li>
              <li>{TRIAL_LIMIT_LABELS.listeningPerDay(TRIAL_DAILY_LIMITS.listeningPerDay)}</li>
              <li>{TRIAL_LIMIT_LABELS.conversationMinutesTotal(TRIAL_DAILY_LIMITS.conversationMinutesTotal)}</li>
            </ul>
            <div className="pt-2 border-t border-slate-700 space-y-1.5">
              <p className="text-xs text-slate-500 leading-relaxed">{SUBSCRIPTION_MESSAGES.trialDataPreservedNote}</p>
              <p className="text-xs text-slate-500 leading-relaxed">{SUBSCRIPTION_MESSAGES.trialBlockedActivitiesNote}</p>
            </div>
          </section>
        )}

        {vm.status === 'expired' && (
          <section className="bg-slate-800 rounded-xl p-5 space-y-1.5">
            <p className="text-xs text-slate-500 leading-relaxed">{SUBSCRIPTION_MESSAGES.trialDataPreservedNote}</p>
            <p className="text-xs text-slate-500 leading-relaxed">{SUBSCRIPTION_MESSAGES.trialBlockedActivitiesNote}</p>
          </section>
        )}

        {vm.showPlanCards && (
          <section className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
            {COMMERCIAL_PLAN_ORDER.map((code) => {
              const plan = COMMERCIAL_PLANS[code];
              // Real Apple-returned price when the native Offering has
              // loaded — never a fixed price once the real product is
              // available (FASE 5). Falls back to the static price on web
              // or before offerings finish loading on native.
              const realOffering = nativePurchase.offerings.find(
                (o) => o.productId === REVENUECAT_SUBSCRIPTION_PRODUCT_IDS[DISPLAY_CODE_TO_DB_PLAN_CODE[code]],
              );
              return (
                <SubscriptionPlanCard
                  key={code}
                  plan={plan}
                  recommended={code === RECOMMENDED_PLAN_CODE}
                  onSubscribe={handleSubscribe}
                  priceLabel={realOffering?.priceFormatted}
                  ctaLoading={nativePurchase.purchasing === realOffering?.productId}
                  ctaDisabled={nativePurchase.purchasing !== null || (nativePurchase.supported && nativePurchase.offeringsLoading)}
                />
              );
            })}
          </section>
        )}

        {/* Real native (iOS) restore/manage — driven by RevenueCat's own
            CustomerInfo, never by the backend's still-hardcoded-false
            canManageSubscription/canRestorePurchases (see the legacy
            section below, kept dormant and separate on purpose). Never
            shown for the internal plan or during trial (FASE 3/4). */}
        {nativeStoreActionsAllowed && nativePurchase.supported && (
          <section className="space-y-2.5 pt-2">
            {nativePurchase.managementUrl && (
              <button
                type="button"
                onClick={handleNativeManage}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-slate-800 border border-slate-700 hover:bg-slate-700 text-slate-200 transition-colors"
              >
                <AppIcon icon={Settings2} className="w-4 h-4 shrink-0" />
                {SUBSCRIPTION_MESSAGES.manageSubscription}
                <AppIcon icon={ExternalLink} className="w-3.5 h-3.5 shrink-0 opacity-60" />
              </button>
            )}
            <button
              type="button"
              onClick={handleRestore}
              disabled={nativePurchase.restoring}
              aria-disabled={nativePurchase.restoring}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium bg-slate-800 border border-slate-700 hover:bg-slate-700 disabled:opacity-60 disabled:cursor-not-allowed text-slate-300 transition-colors"
            >
              <AppIcon icon={RotateCcw} className="w-4 h-4 shrink-0" />
              {nativePurchase.restoring ? SUBSCRIPTION_MESSAGES.restoringLabel : SUBSCRIPTION_MESSAGES.restorePurchases}
            </button>
          </section>
        )}

        <section className="space-y-2.5 pt-2">
          {vm.showManageButton && (
            <button
              type="button"
              onClick={handleLegacyManage}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-slate-800 border border-slate-700 hover:bg-slate-700 text-slate-200 transition-colors"
            >
              <AppIcon icon={Settings2} className="w-4 h-4 shrink-0" />
              {SUBSCRIPTION_MESSAGES.manageSubscription}
            </button>
          )}

          {vm.showRestoreButton && (
            <button
              type="button"
              onClick={handleLegacyRestore}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium bg-slate-800 border border-slate-700 hover:bg-slate-700 text-slate-300 transition-colors"
            >
              <AppIcon icon={RotateCcw} className="w-4 h-4 shrink-0" />
              {SUBSCRIPTION_MESSAGES.restorePurchases}
            </button>
          )}

          <button
            type="button"
            onClick={onBack}
            className="w-full px-4 py-2.5 rounded-xl text-sm font-medium text-slate-400 hover:text-slate-200 transition-colors"
          >
            {SUBSCRIPTION_MESSAGES.backToHome}
          </button>
        </section>
      </div>
    </div>
  );
}
