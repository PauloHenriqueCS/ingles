import { useState } from 'react';
import { ArrowLeft, Clock, Plus, Sparkles } from 'lucide-react';
import { AppIcon } from './AppIcon';
import { useMinutePackages, type MinutePackageDisplay } from '../hooks/useMinutePackages';
import { useNativeSubscriptionPurchase } from '../hooks/useNativeSubscriptionPurchase';
import { REVENUECAT_MINUTE_PACKAGE_IDS } from '../domain/subscription/revenuecat-catalog';
import { formatPriceBRL } from '../domain/subscription/subscription-formatting';
import { MINUTE_PACKAGES_MESSAGES as M } from '../domain/conversation/minute-packages-copy';

interface Props {
  onBack: () => void;
  /** Trial → "assine um plano" routes here. */
  onNavigateToSubscription: () => void;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const secondsToMinutes = (s: number) => Math.round(s / 60);

/** Maps the backend catalog `code` (pacote-300-min…) to the store-agnostic
 *  RevenueCat package identifier (minutes_300…) used to purchase. */
function packageIdFor(code: string): string | null {
  return (REVENUECAT_MINUTE_PACKAGE_IDS as Record<string, string>)[code] ?? null;
}

export default function MinutePackagesView({ onBack, onNavigateToSubscription }: Props) {
  const { data, loading, error, refetch } = useMinutePackages();
  const nativePurchase = useNativeSubscriptionPurchase();
  const [feedback, setFeedback] = useState<string | null>(null);

  async function handleBuy(pkg: MinutePackageDisplay) {
    setFeedback(null);
    const packageId = packageIdFor(pkg.code);
    if (!packageId) return;
    if (!nativePurchase.supported) {
      window.alert(M.webPurchaseUnavailable);
      return;
    }
    const before = data?.balance.extraRemainingSeconds ?? 0;
    const done = await nativePurchase.purchase(packageId);
    if (!done) {
      if (nativePurchase.lastError && nativePurchase.lastError.code !== 'user_cancelled') {
        window.alert(nativePurchase.lastError.message || M.genericError);
      }
      return;
    }
    // The consumable credit lands via the RevenueCat webhook (async) — poll the
    // balance a few times (bounded, never infinite) to confirm it, then show an
    // honest message either way. No remount required.
    let credited = false;
    for (let attempt = 0; attempt < 4 && !credited; attempt++) {
      const fresh = await refetch();
      if (fresh && fresh.balance.extraRemainingSeconds > before) credited = true;
      else if (attempt < 3) await delay(1200);
    }
    setFeedback(credited ? M.purchaseSuccess(pkg.minutes) : M.purchaseSuccessPending(pkg.minutes));
  }

  const header = (
    <header className="sticky top-0 bg-slate-800 border-b border-slate-700 px-4 py-3 z-10 flex items-center gap-3">
      <button
        onClick={onBack}
        className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors"
        aria-label={M.back}
      >
        <AppIcon icon={ArrowLeft} className="w-4 h-4 shrink-0" />
      </button>
      <h1 className="text-base font-semibold text-slate-100">{M.title}</h1>
    </header>
  );

  if (loading || error || !data) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col">
        {header}
        <div className="flex-1 flex items-center justify-center p-4">
          <p className={`text-sm ${error ? 'text-red-400' : 'text-slate-400'}`}>
            {error ? M.loadError : M.loading}
          </p>
        </div>
      </div>
    );
  }

  const { balance, purchaseAvailable, packages } = data;
  const showCards = purchaseAvailable && !balance.unlimited && packages.length > 0;

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      {header}
      <div className="flex-1 overflow-auto p-4 max-w-2xl mx-auto w-full space-y-5 pb-10">

        {/* Balance — server-authoritative, split plan-included vs purchased. */}
        <section className="bg-slate-800 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <AppIcon icon={Clock} className="w-5 h-5 text-blue-400 shrink-0" />
            <h2 className="text-base font-semibold text-slate-100">{M.balanceTitle}</h2>
          </div>
          {balance.unlimited ? (
            <p className="text-sm text-emerald-400 font-medium">{M.unlimitedLabel}</p>
          ) : (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-400">{M.planIncludedLabel}</span>
                <span className="text-slate-200 font-medium">{M.minutesUnit(secondsToMinutes(balance.planIncludedRemainingSeconds ?? 0))}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-400">{M.extraLabel}</span>
                <span className="text-slate-200 font-medium">{M.minutesUnit(secondsToMinutes(balance.extraRemainingSeconds))}</span>
              </div>
              <div className="flex items-center justify-between text-sm border-t border-slate-700 pt-1.5 mt-1.5">
                <span className="text-slate-300 font-medium">{M.totalLabel}</span>
                <span className="text-slate-100 font-semibold">{M.minutesUnit(secondsToMinutes(balance.totalRemainingSeconds ?? 0))}</span>
              </div>
            </div>
          )}
        </section>

        {feedback && (
          <p className="text-sm text-emerald-400 font-medium px-1" role="status">{feedback}</p>
        )}

        {/* Internal/unlimited → never offer purchase. */}
        {balance.unlimited && (
          <p className="text-sm text-slate-400 leading-relaxed px-1">{M.internalNote}</p>
        )}

        {/* Trial / no commercial plan → block, route to subscription. */}
        {!balance.unlimited && !purchaseAvailable && (
          <section className="bg-slate-800 rounded-xl p-5 space-y-3">
            <div className="flex items-center gap-2">
              <AppIcon icon={Sparkles} className="w-5 h-5 text-amber-400 shrink-0" />
              <h2 className="text-base font-semibold text-slate-100">{M.trialBlockedTitle}</h2>
            </div>
            <p className="text-sm text-slate-400 leading-relaxed">{M.trialBlockedSubtitle}</p>
            <button
              type="button"
              onClick={onNavigateToSubscription}
              className="w-full px-4 py-2.5 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors"
            >
              {M.trialBlockedCta}
            </button>
          </section>
        )}

        {showCards && (
          <>
            <section className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {packages.map((pkg) => {
                const packageId = packageIdFor(pkg.code);
                const realOffering = packageId ? nativePurchase.offerings.find((o) => o.packageId === packageId) : undefined;
                const priceLabel = realOffering?.priceFormatted ?? formatPriceBRL(pkg.priceCents);
                const isPurchasing = packageId != null && nativePurchase.purchasing === packageId;
                const disabled = nativePurchase.purchasing !== null || (nativePurchase.supported && nativePurchase.offeringsLoading && nativePurchase.offerings.length === 0);
                return (
                  <div key={pkg.id} className="relative bg-slate-800 border border-slate-700 rounded-2xl p-5 flex flex-col gap-3" data-testid={`minute-pack-${pkg.code}`}>
                    <div>
                      <h3 className="text-base font-semibold text-slate-100">{M.minutesUnit(pkg.minutes)}</h3>
                      <p className="mt-1 text-2xl font-bold text-slate-100">{priceLabel}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => { if (!disabled && !isPurchasing) handleBuy(pkg); }}
                      disabled={disabled || isPurchasing}
                      aria-disabled={disabled || isPurchasing}
                      className="mt-auto w-full flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 disabled:opacity-60 disabled:cursor-not-allowed text-white transition-colors"
                    >
                      {!isPurchasing && <AppIcon icon={Plus} className="w-4 h-4 shrink-0" />}
                      {isPurchasing ? M.purchasingLabel : M.buyCta(pkg.minutes)}
                    </button>
                  </div>
                );
              })}
            </section>
            <p className="text-xs text-slate-500 leading-relaxed px-1">{M.consumptionNote}</p>
          </>
        )}

      </div>
    </div>
  );
}
