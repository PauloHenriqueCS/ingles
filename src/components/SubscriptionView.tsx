import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Clock, CheckCircle2, AlertTriangle, Ban, CreditCard, RotateCcw, Settings2, ExternalLink, RefreshCw } from 'lucide-react';
import { AppIcon } from './AppIcon';
import SubscriptionPlanCard from './SubscriptionPlanCard';
import type { CommercialPlanDisplay, SubscriptionAccessStatus } from '../domain/subscription/subscription-types';
import { COMMERCIAL_PLAN_ORDER, COMMERCIAL_PLANS, RECOMMENDED_PLAN_CODE } from '../domain/subscription/subscription-plans';
import { SUBSCRIPTION_MESSAGES } from '../domain/subscription/subscription-copy';
import { MINUTE_PACKAGES_MESSAGES } from '../domain/conversation/minute-packages-copy';
import { getMockSubscriptionState, MOCK_STATUS_OPTIONS } from '../domain/subscription/subscription-mock-data';
import { buildSubscriptionViewModel } from '../domain/subscription/subscription-view-model';
import { formatDatePtBr, computeDaysRemaining, formatTrialDaysRemainingLabel } from '../domain/subscription/subscription-formatting';
import { type PlanCardAction } from '../domain/subscription/subscription-plan-actions';
import { resolveSubscriptionUiState, resolvePurchaseMode, isPlanCtaDisabled, type StoreSubscriptionSnapshot, type SubscriptionUiState } from '../domain/subscription/resolve-subscription-ui-state';
import { useSubscriptionStatus } from '../hooks/useSubscriptionStatus';
import { useNativeSubscriptionPurchase } from '../hooks/useNativeSubscriptionPurchase';
import { REVENUECAT_SUBSCRIPTION_PACKAGE_IDS, type OrodimCommercialPlanCode } from '../domain/subscription/revenuecat-catalog';
import { isNativeStoreSectionVisible, shouldShowManageSubscriptionButton } from '../domain/subscription/native-subscription-actions';

interface Props {
  onBack: () => void;
  /** Opens the shared "Minutos adicionais" screen (also reachable from the
   *  conversation area). Optional so existing tests/mounts stay valid. */
  onNavigateToMinutePackages?: () => void;
  /** Testing/dev only — which mock state to render initially. When set, this
   *  overrides the real fetched status for the whole session (see the DEV
   *  switcher below); leave unset in production. */
  initialStatus?: SubscriptionAccessStatus;
}

/** Topo icon keyed by the UNIFIED resolved state — the whole header derives
 *  from resolveSubscriptionUiState, never from a backend-only view-model. */
const STATE_ICON: Record<SubscriptionUiState, typeof Clock> = {
  reconciling: RefreshCw,
  trial: Clock,
  active: CheckCircle2,
  pending_downgrade: CheckCircle2,
  pending_upgrade: CheckCircle2,
  not_renewing: CheckCircle2,
  internal: CheckCircle2,
  cancelled_active: Ban,
  expired: AlertTriangle,
  billing_issue: CreditCard,
};

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

/** Bounded reconciliation retry (store↔backend eventual consistency after a
 *  purchase/change). Small, finite — never a polling loop. Reconciling ALWAYS
 *  ends after at most this many attempts, converged or not. */
const RECONCILE_MAX_ATTEMPTS = 3;
const RECONCILE_RETRY_MS = 800;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export default function SubscriptionView({ onBack, onNavigateToMinutePackages, initialStatus }: Props) {
  const [mockOverride, setMockOverride] = useState<SubscriptionAccessStatus | null>(initialStatus ?? null);
  const { state: fetchedState, error, refetch } = useSubscriptionStatus();
  const state = mockOverride ? getMockSubscriptionState(mockOverride) : fetchedState;
  const vm = state ? buildSubscriptionViewModel(state) : null;
  const nativePurchase = useNativeSubscriptionPurchase();

  // A backend↔store reconciliation is in flight (the neutral "Atualizando sua
  // assinatura…" state).
  const [reconciling, setReconciling] = useState(false);
  const reconcileAttempted = useRef(false); // auto-reconcile fires at most once per entry
  const reconcileRunningRef = useRef(false); // prevents overlapping runs
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const { supported: rcSupported, reloadStore } = nativePurchase;

  // The ONE reconciliation runner. Used both by the auto-reconcile effect and
  // right after a successful purchase/change. Guarantees termination:
  //   - a bounded retry loop (RECONCILE_MAX_ATTEMPTS) for eventual consistency,
  //   - reconciling is ALWAYS cleared in `finally` (guarded only by unmount) —
  //     never stranded true by a dependency change (the audited infinite
  //     "Atualizando…" spinner),
  //   - an overlap guard so the effect + the post-purchase call never double-run.
  const reconcile = useCallback(async () => {
    if (reconcileRunningRef.current) return;
    reconcileRunningRef.current = true;
    setReconciling(true);
    try {
      for (let attempt = 0; attempt < RECONCILE_MAX_ATTEMPTS; attempt++) {
        const backendState = await refetch({ sync: true }); // POST /sync then re-resolve
        const entitlements = await reloadStore();           // fresh CustomerInfo
        if (!backendState) break; // /status failed — keep last safe state, stop
        const snapshot: StoreSubscriptionSnapshot = {
          supported: rcSupported,
          loaded: true,
          activeEntitlementIds: entitlements,
          managementUrl: null, // irrelevant to convergence
        };
        if (!resolveSubscriptionUiState(backendState, snapshot, false).needsReconciliation) break; // converged
        if (attempt < RECONCILE_MAX_ATTEMPTS - 1) await delay(RECONCILE_RETRY_MS);
      }
    } catch (err) {
      // Best-effort — never leave the screen stuck. Diagnostic only.
      console.warn('[subscription] reconcile failed', err instanceof Error ? err.message : err);
    } finally {
      if (mountedRef.current) setReconciling(false);
      reconcileRunningRef.current = false;
    }
  }, [refetch, reloadStore, rcSupported]);

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
  const uiState = resolved?.subscriptionState ?? null;
  const isReconciling = uiState === 'reconciling';
  // A DEFERRED plan change is scheduled (current plan stays active). Never a
  // cancellation — see resolve-subscription-ui-state.ts / status service.
  const isPendingChange = uiState === 'pending_downgrade' || uiState === 'pending_upgrade';
  // Won't auto-renew, no known pending plan — the honest fallback.
  const isNotRenewing = uiState === 'not_renewing';
  // active / pending / not_renewing all render a "Plano atual: X" header block.
  const isCommercialActive = uiState === 'active' || isPendingChange || isNotRenewing;

  // ── Topo derived ENTIRELY from `resolved` (single source, no vm.status). ──
  const StatusIcon = uiState ? STATE_ICON[uiState] : Clock;
  const currentPlanName = resolved?.currentPlanName ?? null;
  const pendingPlanName = resolved?.pendingPlanName ?? null;
  const pendingChangeAtLabel = resolved?.effectiveChangeAt ? formatDatePtBr(resolved.effectiveChangeAt) : null;
  const accessUntilLabel = resolved?.subscriptionExpiresAt ? formatDatePtBr(resolved.subscriptionExpiresAt) : null;
  const trialDays = resolved ? (resolved.trialEndsAt ? computeDaysRemaining(resolved.trialEndsAt) : resolved.trialDaysRemaining ?? 0) : 0;
  const trialDaysLabel = formatTrialDaysRemainingLabel(trialDays);
  const trialEndsLabel = resolved?.trialEndsAt ? formatDatePtBr(resolved.trialEndsAt) : null;
  const topoTitle =
    uiState === 'reconciling' ? SUBSCRIPTION_MESSAGES.reconcilingTitle
    : uiState === 'internal' ? SUBSCRIPTION_MESSAGES.internalTitle
    : uiState === 'trial' ? SUBSCRIPTION_MESSAGES.trialingTitle
    : uiState === 'expired' ? SUBSCRIPTION_MESSAGES.expiredTitle
    : uiState === 'cancelled_active' ? SUBSCRIPTION_MESSAGES.canceledTitle
    : uiState === 'billing_issue' ? SUBSCRIPTION_MESSAGES.billingIssueTitle
    : (currentPlanName ?? '—'); // active / pending / not_renewing

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
    void reconcile(); // owns the spinner + bounded retry + guaranteed clear
  }, [needsReconciliation, nativePurchase.customerInfoLoaded, mockOverride, reconcile]);

  // FASE 3/4: never offered to the internal plan or during trial — only a
  // real commercial assignment (active/canceled/billing_issue) or no
  // assignment at all (choosing a first plan) makes sense to restore/manage.
  // See native-subscription-actions.ts for the pure, unit-tested rule.
  const nativeStoreActionsAllowed = state != null && isNativeStoreSectionVisible(state.accessType, nativePurchase.supported);
  const showManageSubscriptionButton = state != null
    && shouldShowManageSubscriptionButton(state.accessType, nativePurchase.supported, nativePurchase.managementUrl);

  // Subscribe / upgrade / downgrade. The mode is decided from the store's LIVE
  // entitlements (resolvePurchaseMode), NOT a stale union currentPlan — so we
  // only ever send a replacement (oldProductIdentifier) when the source plan is
  // genuinely active in the store right now. Otherwise it's a plain purchase, so
  // Google Play checkout actually opens (the audited invalid-replacement bug).
  // 'current'/'next' never reach here — their CTAs are disabled.
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
    const decision = resolvePurchaseMode(plan.code, nativePurchase.activeEntitlementIds);

    // Already owns the target — never re-call the store; reconcile + reassure.
    if (decision.mode === 'blocked_owned_target') {
      reconcileAttempted.current = true; // claim it so the auto-effect won't double-fire
      await reconcile();                 // shared runner: spinner + bounded retry + guaranteed clear
      window.alert(SUBSCRIPTION_MESSAGES.alreadyActiveNote);
      return;
    }

    let done = false;
    if (decision.mode === 'new_purchase' || !decision.sourcePlan) {
      // No commercial subscription genuinely active → plain purchase (NO
      // oldProductIdentifier), so checkout opens even if the backend/union
      // still thinks a now-expired plan is "current".
      done = await nativePurchase.purchase(targetPackageId);
    } else {
      const sourcePackageId = REVENUECAT_SUBSCRIPTION_PACKAGE_IDS[DISPLAY_CODE_TO_DB_PLAN_CODE[decision.sourcePlan]];
      const sourceOffering = nativePurchase.offerings.find((o) => o.packageId === sourcePackageId);
      if (!sourceOffering) {
        // The genuinely-active source has no loaded offering (rare) — fall back
        // to a plain purchase rather than send an unverifiable oldProductId.
        done = await nativePurchase.purchase(targetPackageId);
      } else {
        const mode = decision.mode === 'upgrade_replacement' ? 'upgrade' : 'downgrade';
        done = await nativePurchase.changePlan(targetPackageId, sourceOffering.productId, mode);
      }
    }
    if (done) {
      // Converge IN-SESSION via the shared runner — bounded retry, and the
      // "Atualizando…" spinner ALWAYS ends (no infinite spinner after upgrade).
      // The screen updates without needing the user to leave and re-enter.
      reconcileAttempted.current = true;
      await reconcile();
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

        {/* Status header — derived ENTIRELY from `resolved` (same source as the
            cards below). Never trial-topo + commercial-card simultaneously. */}
        <section className="bg-slate-800 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <AppIcon icon={StatusIcon} className={`w-5 h-5 text-blue-400 shrink-0 ${isReconciling ? 'animate-spin' : ''}`} />
            <h2 className="text-base font-semibold text-slate-100">{topoTitle}</h2>
          </div>

          {uiState === 'reconciling' && (
            <p className="text-sm text-slate-400 leading-relaxed">{SUBSCRIPTION_MESSAGES.reconcilingSubtitle}</p>
          )}

          {uiState === 'internal' && (
            <div className="space-y-1">
              <p className="text-xs text-emerald-400 font-medium">{SUBSCRIPTION_MESSAGES.internalStatusLabel}</p>
              <p className="text-xs text-slate-500">{SUBSCRIPTION_MESSAGES.internalComplementaryNote}</p>
            </div>
          )}

          {uiState === 'trial' && (
            <div className="space-y-0.5">
              <p className="text-sm text-slate-300">{trialDaysLabel}</p>
              {trialEndsLabel && <p className="text-xs text-slate-500">Termina em {trialEndsLabel}</p>}
            </div>
          )}

          {uiState === 'expired' && (
            <p className="text-sm text-slate-400 leading-relaxed">{SUBSCRIPTION_MESSAGES.expiredSubtitle}</p>
          )}

          {isCommercialActive && (
            <div className="space-y-1">
              <p className="text-sm text-slate-300">Plano atual: <span className="font-medium text-slate-100">{currentPlanName}</span></p>

              {isPendingChange ? (
                // A scheduled DEFERRED change — current plan stays active; show
                // the scheduled plan + date, never "Assinatura ativa"/renovação
                // and never "cancelada".
                <p className="text-xs text-amber-400 font-medium">
                  {pendingPlanName && pendingChangeAtLabel
                    ? SUBSCRIPTION_MESSAGES.pendingChangeScheduledNote(pendingPlanName, pendingChangeAtLabel)
                    : pendingPlanName
                      ? SUBSCRIPTION_MESSAGES.pendingChangeGenericNote(pendingPlanName)
                      : null}
                </p>
              ) : isNotRenewing ? (
                <p className="text-xs text-slate-400">
                  {SUBSCRIPTION_MESSAGES.notRenewingNote}{accessUntilLabel ? ` ${accessUntilLabel}` : ''}
                </p>
              ) : (
                <>
                  <p className="text-xs text-emerald-400 font-medium">{SUBSCRIPTION_MESSAGES.activeStatusLabel}</p>
                  {accessUntilLabel && (
                    <p className="text-xs text-slate-500">Próxima renovação: {accessUntilLabel}</p>
                  )}
                </>
              )}
            </div>
          )}

          {uiState === 'cancelled_active' && (
            <div className="space-y-1">
              {currentPlanName && (
                <p className="text-sm text-slate-300">Plano anterior: <span className="font-medium text-slate-100">{currentPlanName}</span></p>
              )}
              <p className="text-xs text-slate-500">Acesso até: {accessUntilLabel ?? SUBSCRIPTION_MESSAGES.canceledAccessEndedNote}</p>
            </div>
          )}

          {uiState === 'billing_issue' && (
            <div className="space-y-1">
              {SUBSCRIPTION_MESSAGES.billingIssueSubtitle && (
                <p className="text-sm text-slate-400 leading-relaxed">{SUBSCRIPTION_MESSAGES.billingIssueSubtitle}</p>
              )}
              {currentPlanName && (
                <p className="text-sm text-slate-300">Plano atual: <span className="font-medium text-slate-100">{currentPlanName}</span></p>
              )}
              {accessUntilLabel && (
                <p className="text-xs text-slate-500">{SUBSCRIPTION_MESSAGES.billingIssueAccessUntilNote} {accessUntilLabel}</p>
              )}
            </div>
          )}
        </section>

        {/* Minutos adicionais — entry point (path A). Shown to commercial plan
            holders (eligibility is re-checked server-side on the packages
            screen). Placed after the status summary and BEFORE the plan cards. */}
        {onNavigateToMinutePackages && resolved && resolved.currentPlan !== null && (
          <button
            type="button"
            onClick={onNavigateToMinutePackages}
            className="w-full flex items-center gap-3 bg-slate-800 border border-slate-700 hover:bg-slate-700 rounded-xl p-4 text-left transition-colors"
            data-testid="buy-minute-packages-cta"
          >
            <span className="w-9 h-9 shrink-0 rounded-lg bg-blue-600/20 flex items-center justify-center">
              <AppIcon icon={Clock} className="w-5 h-5 text-blue-400" />
            </span>
            <span className="flex-1">
              <span className="block text-sm font-semibold text-slate-100">{MINUTE_PACKAGES_MESSAGES.entryCtaTitle}</span>
              <span className="block text-xs text-slate-400">{MINUTE_PACKAGES_MESSAGES.entrySubtitle}</span>
            </span>
            <AppIcon icon={ExternalLink} className="w-4 h-4 text-slate-500 shrink-0" />
          </button>
        )}

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
                  ctaDisabled={isPlanCtaDisabled({
                    reconciling: resolved.cardsDisabled,
                    purchaseInFlight: nativePurchase.purchasing !== null,
                    supported: nativePurchase.supported,
                    offeringsLoading: nativePurchase.offeringsLoading,
                    offeringsLoaded: nativePurchase.offerings.length > 0,
                  })}
                />
              );
            })}
          </section>
        )}

        {/* Honest footnote moved BELOW the plans so no big text block pushes the
            cards down (redesign requirement #1/#10). */}
        {(uiState === 'trial' || uiState === 'expired' || uiState === 'cancelled_active') && (
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
