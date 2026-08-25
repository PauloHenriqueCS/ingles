import { Check } from 'lucide-react';
import { AppIcon } from './AppIcon';
import type { CommercialPlanDisplay } from '../domain/subscription/subscription-types';
import type { PlanCardAction } from '../domain/subscription/subscription-plan-actions';
import { formatPriceBRL } from '../domain/subscription/subscription-formatting';
import { SUBSCRIPTION_MESSAGES } from '../domain/subscription/subscription-copy';
import { buildPlanBenefitLines } from '../domain/subscription/subscription-plan-benefits';

interface Props {
  plan: CommercialPlanDisplay;
  recommended: boolean;
  /** What this card offers given the user's current subscription — decides the
   *  CTA/badge. 'current' shows the "Plano atual" badge and a disabled CTA;
   *  a plan the user isn't on is always still offered (upgrade/downgrade),
   *  never hidden. See subscription-plan-actions.ts. */
  action: PlanCardAction;
  /** Unified handler for subscribe/upgrade/downgrade — never called for 'current'. */
  onCta: (plan: CommercialPlanDisplay, action: PlanCardAction) => void;
  /** Real store-returned price string (e.g. "R$ 34,90"), when the native
   *  Offerings are loaded — overrides the static formatPriceBRL fallback. */
  priceLabel?: string;
  /** Billing-cycle suffix shown after the price (e.g. "mês", "ano", "3 meses"),
   *  derived from the store's real subscriptionPeriod when the native Offering
   *  is loaded. Falls back to the default monthly label (web / pre-load). */
  periodLabel?: string;
  /** Per-card in-flight state — never a global spinner; the button disables
   *  itself to prevent a double-tap. */
  ctaLoading?: boolean;
  ctaDisabled?: boolean;
}

function ctaLabelFor(plan: CommercialPlanDisplay, action: PlanCardAction): string {
  switch (action) {
    case 'current':
      return SUBSCRIPTION_MESSAGES.currentPlanBadge;
    case 'upgrade':
      return SUBSCRIPTION_MESSAGES.upgradeToPlanCta(plan.name);
    case 'downgrade':
      return SUBSCRIPTION_MESSAGES.changeToPlanCta(plan.name);
    case 'subscribe':
      return plan.code === 'essential' ? SUBSCRIPTION_MESSAGES.subscribeEssential : SUBSCRIPTION_MESSAGES.subscribePlus;
    case 'next':
      // A change already scheduled — locked, never a live CTA.
      return SUBSCRIPTION_MESSAGES.planScheduledLabel;
  }
}

export default function SubscriptionPlanCard({ plan, recommended, action, onCta, priceLabel, periodLabel, ctaLoading, ctaDisabled }: Props) {
  const benefits = buildPlanBenefitLines(plan, import.meta.env.DEV);
  const isCurrent = action === 'current';
  // 'next' = the plan a DEFERRED change is already scheduled to — badge only,
  // never re-offered as a purchase/change.
  const isNext = action === 'next';
  // 'current'/'next' take precedence over 'recommended' for the top badge.
  const badge = isCurrent
    ? { text: SUBSCRIPTION_MESSAGES.currentPlanBadge, className: 'bg-emerald-600' }
    : isNext
      ? { text: SUBSCRIPTION_MESSAGES.nextPlanBadge, className: 'bg-amber-600' }
      : recommended
        ? { text: SUBSCRIPTION_MESSAGES.recommendedBadge, className: 'bg-blue-600' }
        : null;
  const loadingLabel = action === 'upgrade' || action === 'downgrade'
    ? SUBSCRIPTION_MESSAGES.planChangeProcessingLabel
    : SUBSCRIPTION_MESSAGES.purchasingLabel;
  const disabled = isCurrent || isNext || ctaDisabled || ctaLoading;

  return (
    <div
      className={`relative bg-slate-800 border rounded-2xl p-5 flex flex-col gap-4 ${
        isCurrent ? 'border-emerald-600/70 ring-1 ring-emerald-600/30' : isNext ? 'border-amber-600/60 ring-1 ring-amber-600/25' : recommended ? 'border-blue-600 ring-1 ring-blue-600/40' : 'border-slate-700'
      }`}
      data-testid={`plan-card-${plan.code}`}
      data-action={action}
    >
      {badge && (
        <span className={`absolute -top-3 left-4 px-2 py-0.5 rounded-full ${badge.className} text-white text-xs font-semibold`}>
          {badge.text}
        </span>
      )}

      <div>
        <h3 className="text-base font-semibold text-slate-100">{plan.name}</h3>
        <p className="mt-1">
          <span className="text-2xl font-bold text-slate-100">{priceLabel ?? formatPriceBRL(plan.priceCents)}</span>
          <span className="text-sm font-normal text-slate-400"> /{periodLabel ?? SUBSCRIPTION_MESSAGES.defaultBillingPeriodLabel}</span>
        </p>
        {/* Per-subscription auto-renewal disclosure (App Store Guideline 3.1.2(c)). */}
        <p className="mt-0.5 text-xs text-slate-500">{SUBSCRIPTION_MESSAGES.autoRenewCardNote}</p>
      </div>

      <ul className="space-y-2 flex-1">
        {benefits.map((benefit) => (
          <li key={benefit} className="flex items-start gap-2 text-sm text-slate-300">
            <AppIcon icon={Check} className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
            <span>{benefit}</span>
          </li>
        ))}
      </ul>

      {plan.allowsExtraMinutePackages && (
        <p className="text-xs text-slate-500 leading-relaxed">{SUBSCRIPTION_MESSAGES.extraMinutePackagesNote}</p>
      )}

      <div className="space-y-1.5">
        <button
          type="button"
          onClick={() => { if (!disabled) onCta(plan, action); }}
          disabled={disabled}
          aria-disabled={disabled}
          className={`w-full px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors disabled:cursor-not-allowed ${
            isCurrent || isNext
              ? 'bg-slate-700 text-slate-300 disabled:opacity-100'
              : 'bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-60'
          }`}
        >
          {ctaLoading ? loadingLabel : ctaLabelFor(plan, action)}
        </button>
        {/* Google Play downgrades take effect at the next renewal (DEFERRED). */}
        {action === 'downgrade' && (
          <p className="text-xs text-slate-500 leading-relaxed">{SUBSCRIPTION_MESSAGES.downgradeDeferredNote}</p>
        )}
      </div>
    </div>
  );
}
