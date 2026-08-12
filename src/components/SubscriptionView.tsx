import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Clock, CheckCircle2, AlertTriangle, Ban, CreditCard, RotateCcw, Settings2, ExternalLink, RefreshCw } from 'lucide-react';
import { AppIcon } from './AppIcon';
import SubscriptionPlanCard from './SubscriptionPlanCard';
import type { CommercialPlanDisplay, SubscriptionAccessStatus } from '../domain/subscription/subscription-types';
import { COMMERCIAL_PLAN_ORDER, COMMERCIAL_PLANS, RECOMMENDED_PLAN_CODE } from '../domain/subscription/subscription-plans';
import { SUBSCRIPTION_MESSAGES } from '../domain/subscription/subscription-copy';
import { getMockSubscriptionState, MOCK_STATUS_OPTIONS } from '../domain/subscription/subscription-mock-data';
import { buildSubscriptionViewModel } from '../domain/subscription/subscription-view-model';
import { formatDatePtBr } from '../domain/subscription/subscription-formatting';
import { type PlanCardAction } from '../domain/subscription/subscription-plan-actions';
import { resolveSubscriptionUiState, type StoreSubscriptionSnapshot } from '../domain/subscription/resolve-subscription-ui-state';
import { useSubscriptionStatus } from '../hooks/useSubscriptionStatus';
import { useNativeSubscriptionPurchase } from '../hooks/useNativeSubscriptionPurchase';
import { REVENUECAT_SUBSCRIPTION_PACKAGE_IDS, REVENUECAT_ENTITLEMENT_IDS, type OrodimCommercialPlanCode } from '../domain/subscription/revenuecat-catalog';
import { isNativeStoreSectionVisible, shouldShowManageSubscriptionButton } from '../domain/subscription/native-subscription-actions';

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
  const nativePurchase = useNativeSubscriptionPurchase();

  // A one-shot backend↔store reconciliation is in flight (the neutral
  // "Atualizando sua assinatura…" state). UI-only; the ref makes it fire at
  // most once per screen entry — never a loop, even if /sync fails to converge.
  const [reconciling, setReconciling] = useState(false);
  const reconcileAttempted = useRef(false);

  // The single coherent state — backend (access truth) folded with RevenueCat
  // CustomerInfo (ownership truth). Every CTA/badge below reads from here, so
  // the screen can never offer a plan the store already owns (the bug).
  const storeSnapshot: StoreSubscriptionSnapshot = {
    supported: nativePurchase.supported,
    loaded: nativePurchase.customerInfoLoaded,
    activeEntitlementIds: nativePurchase.activeEntitlementIds,
    managementUrl: nativePurchase.managementUrl,
  };
  const resolved = state ? resolveSubscriptionUiState(state, storeSnapshot, reconciling) : null;
  const isReconciling = resolved?.subscriptionState === 'reconciling';
  // A DEFERRED plan change is scheduled (current plan stays active). Never a
  // cancellation — see resolve-subscription-ui-state.ts / status service.
  const isPendingChange = resolved?.subscriptionState === 'pending_downgrade' || resolved?.subscriptionState === 'pending_upgrade';
  // Won't auto-renew, no known pending plan — the honest fallback.
  const isNotRenewing = resolved?.subscriptionState === 'not_renewing';
  const pendingChangeAtLabel = resolved?.effectiveChangeAt ? formatDatePtBr(resolved.effectiveChangeAt) : null;
  const StatusIcon = isReconciling ? RefreshCw : vm ? STATUS_ICON[vm.status] : Clock;

  // Auto-reconcile ONCE when the store proves the user owns a commercial plan
  // the backend hasn't caught up to yet (e.g. backend still "trial" while the
  // Play Store already owns Essencial). Runs a single POST /sync, then re-reads
  // /status and the store. Never on the DEV mock switcher, never on web
  // (needsReconciliation is false there), never more than once.
  const needsReconciliation = resolved?.needsReconciliation ?? false;
  useEffect(() => {
    if (mockOverride) return;
    if (!nativePurchase.customerInfoLoaded) return;
    if (!needsReconciliation || reconcileAttempted.current) return;
    reconcileAttempted.current = true;
    let cancelled = false;
    setReconciling(true);
    (async () => {
      try {
        await refetch({ sync: true });
        nativePurchase.refreshStore();
      } catch {
        // Reconciliation is best-effort — a /sync failure must never break the
        // screen or retry in a loop. The resolved state still stays coherent
        // via the union of backend + store, so no bad "subscribe" is offered.
      } finally {
        if (!cancelled) setReconciling(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsReconciliation, nativePurchase.customerInfoLoaded, mockOverride]);

  // FASE 3/4: never offered to the internal plan or during trial — only a
  // real commercial assignment (active/canceled/billing_issue) or no
  // assignment at all (choosing a first plan) makes sense to restore/manage.
  // See native-subscription-actions.ts for the pure, unit-tested rule.
  const nativeStoreActionsAllowed = state != null && isNativeStoreSectionVisible(state.accessType, nativePurchase.supported);
  const showManageSubscriptionButton = state != null
    && shouldShowManageSubscriptionButton(state.accessType, nativePurchase.supported, nativePurchase.managementUrl);

  // Unified subscribe / upgrade / downgrade. A first purchase ('subscribe')
  // calls purchase(); an upgrade/downgrade calls changePlan() with the CURRENT
  // plan's store product id so the store REPLACES the subscription (never a
  // parallel one). 'current' (own plan) and 'next' (already-scheduled pending
  // change) never reach here — their CTAs are disabled.
  async function handlePlanCta(plan: CommercialPlanDisplay, action: PlanCardAction) {
    if (action === 'current' || action === 'next' || isReconciling) return;
    if (!nativePurchase.supported) {
      // FASE 7: the website never sells subscriptions — no checkout, no
      // store call, just an honest explanation.
      window.alert(SUBSCRIPTION_MESSAGES.webPurchaseUnavailableNote);
      return;
    }
    const targetDbCode = DISPLAY_CODE_TO_DB_PLAN_CODE[plan.code];
    const targetPackageId = REVENUECAT_SUBSCRIPTION_PACKAGE_IDS[targetDbCode];

    // Click guard: never call the store for a product it already owns. Google
    // Play's "Você já possui este produto" must not be how the user discovers
    // their real state — if the store already owns the target, silently
    // reconcile with the backend and reassure instead of purchasing again.
    if (nativePurchase.activeEntitlementIds.includes(REVENUECAT_ENTITLEMENT_IDS[targetDbCode])) {
      setReconciling(true);
      try {
        await refetch({ sync: true });
        nativePurchase.refreshStore();
      } catch {
        // best-effort — never break the screen on a sync failure
      } finally {
        setReconciling(false);
      }
      window.alert(SUBSCRIPTION_MESSAGES.alreadyActiveNote);
      return;
    }

    let done = false;
    if (action === 'subscribe') {
      done = await nativePurchase.purchase(targetPackageId);
    } else {
      // upgrade | downgrade — resolve the CURRENT plan from the unified,
      // store-aware state (not backend-only), so a replacement still works
      // while the backend is momentarily stale. Android's replacement flow
      // needs the current plan's store product id.
      const currentCode = resolved?.currentPlan ?? null;
      const currentPackageId = currentCode ? REVENUECAT_SUBSCRIPTION_PACKAGE_IDS[DISPLAY_CODE_TO_DB_PLAN_CODE[currentCode]] : null;
      const currentOffering = currentPackageId
        ? nativePurchase.offerings.find((o) => o.packageId === currentPackageId)
        : undefined;
      if (!currentOffering) {
        window.alert(SUBSCRIPTION_MESSAGES.planChangeUnavailableNote);
        return;
      }
      done = await nativePurchase.changePlan(targetPackageId, currentOffering.productId, action);
    }
    if (done) {
      await refetch({ sync: true }); // reconcile with the backend for real, never optimistic-only
      nativePurchase.refreshStore();
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
            <AppIcon icon={StatusIcon} className={`w-5 h-5 text-blue-400 shrink-0 ${isReconciling ? 'animate-spin' : ''}`} />
            <h2 className="text-base font-semibold text-slate-100">
              {isReconciling ? SUBSCRIPTION_MESSAGES.reconcilingTitle : vm.headline}
            </h2>
          </div>

          {isReconciling ? (
            <p className="text-sm text-slate-400 leading-relaxed">{SUBSCRIPTION_MESSAGES.reconcilingSubtitle}</p>
          ) : (
            vm.subheadline && <p className="text-sm text-slate-400 leading-relaxed">{vm.subheadline}</p>
          )}

          {!isReconciling && vm.status === 'trialing' && (
            <div className="space-y-0.5">
              <p className="text-sm text-slate-300">{vm.trialDaysRemainingLabel}</p>
              {vm.trialEndsAtLabel && (
                <p className="text-xs text-slate-500">Termina em {vm.trialEndsAtLabel}</p>
              )}
            </div>
          )}

          {!isReconciling && vm.status === 'active' && (
            <div className="space-y-1">
              <p className="text-sm text-slate-300">Plano atual: <span className="font-medium text-slate-100">{vm.currentPlanName}</span></p>

              {isPendingChange ? (
                // A scheduled DEFERRED change — current plan stays active; show
                // the scheduled plan + date, never "Assinatura ativa"/renovação
                // (it won't renew as the current plan) and never "cancelada".
                <p className="text-xs text-amber-400 font-medium">
                  {state?.pendingPlanName && pendingChangeAtLabel
                    ? SUBSCRIPTION_MESSAGES.pendingChangeScheduledNote(state.pendingPlanName, pendingChangeAtLabel)
                    : state?.pendingPlanName
                      ? SUBSCRIPTION_MESSAGES.pendingChangeGenericNote(state.pendingPlanName)
                      : null}
                </p>
              ) : isNotRenewing ? (
                // Won't auto-renew, no known target plan — honest, never a
                // cancellation claim.
                <p className="text-xs text-slate-400">
                  {SUBSCRIPTION_MESSAGES.notRenewingNote}{vm.renewalLabel ? ` ${vm.renewalLabel}` : ''}
                </p>
              ) : (
                <>
                  <p className="text-xs text-emerald-400 font-medium">{vm.activeStatusLabel}</p>
                  {/* Omitted entirely (never an "unavailable" placeholder) when
                      there is no real renewal date — always the case for the
                      internal unlimited plan, which has no renewal at all. */}
                  {vm.renewalLabel && (
                    <p className="text-xs text-slate-500">Próxima renovação: {vm.renewalLabel}</p>
                  )}
                </>
              )}
            </div>
          )}

          {!isReconciling && vm.status === 'canceled' && (
            <div className="space-y-1">
              {vm.canceledPlanName && (
                <p className="text-sm text-slate-300">Plano anterior: <span className="font-medium text-slate-100">{vm.canceledPlanName}</span></p>
              )}
              <p className="text-xs text-slate-500">Acesso até: {vm.accessEndsAtLabel}</p>
            </div>
          )}

          {!isReconciling && vm.status === 'billing_issue' && (
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

        {/* Plans are the focus — right below the short status, never hidden
            once the user subscribed. An existing plan is badged "Plano atual"
            and the other stays visible as an upgrade/downgrade. */}
        {vm.showPlanCards && state && resolved && (
          <section className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {COMMERCIAL_PLAN_ORDER.map((code) => {
              const plan = COMMERCIAL_PLANS[code];
              // CTA/badge come from the unified state (backend + store), never
              // backend-only — this is what keeps a store-owned plan out of a
              // "subscribe" CTA.
              const action = code === 'essential' ? resolved.essentialCardAction : resolved.plusCardAction;
              const packageId = REVENUECAT_SUBSCRIPTION_PACKAGE_IDS[DISPLAY_CODE_TO_DB_PLAN_CODE[code]];
              // Real store-returned price once the native Offering loaded
              // (FASE 5); static fallback on web / before load. Matched by
              // package id so it works on both stores (see the catalog).
              const realOffering = nativePurchase.offerings.find((o) => o.packageId === packageId);
              return (
                <SubscriptionPlanCard
                  key={code}
                  plan={plan}
                  recommended={code === RECOMMENDED_PLAN_CODE}
                  action={action}
                  onCta={handlePlanCta}
                  priceLabel={realOffering?.priceFormatted}
                  ctaLoading={nativePurchase.purchasing === packageId}
                  ctaDisabled={resolved.cardsDisabled || nativePurchase.purchasing !== null || (nativePurchase.supported && nativePurchase.offeringsLoading)}
                />
              );
            })}
          </section>
        )}

        {/* Honest footnote moved BELOW the plans so no big text block pushes the
            cards down (redesign requirement #1/#10). */}
        {!isReconciling && (vm.status === 'trialing' || vm.status === 'expired' || vm.status === 'canceled') && (
          <p className="text-xs text-slate-500 leading-relaxed px-1">{SUBSCRIPTION_MESSAGES.trialDataPreservedNote}</p>
        )}

        {/* Real native (iOS) restore/manage — driven by RevenueCat's own
            CustomerInfo, never by the backend's still-hardcoded-false
            canManageSubscription/canRestorePurchases (see the legacy
            section below, kept dormant and separate on purpose). Never
            shown for the internal plan or during trial (FASE 3/4). */}
        {nativeStoreActionsAllowed && (
          <section className="space-y-2.5 pt-2">
            {showManageSubscriptionButton && (
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
