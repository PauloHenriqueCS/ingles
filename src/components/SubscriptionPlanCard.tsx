import { Check } from 'lucide-react';
import { AppIcon } from './AppIcon';
import type { CommercialPlanDisplay } from '../domain/subscription/subscription-types';
import { formatPriceBRL } from '../domain/subscription/subscription-formatting';
import { SUBSCRIPTION_MESSAGES } from '../domain/subscription/subscription-copy';
import { buildPlanBenefitLines } from '../domain/subscription/subscription-plan-benefits';

interface Props {
  plan: CommercialPlanDisplay;
  recommended: boolean;
  onSubscribe: (plan: CommercialPlanDisplay) => void;
}

export default function SubscriptionPlanCard({ plan, recommended, onSubscribe }: Props) {
  const benefits = buildPlanBenefitLines(plan, import.meta.env.DEV);

  const subscribeLabel = plan.code === 'essential' ? SUBSCRIPTION_MESSAGES.subscribeEssential : SUBSCRIPTION_MESSAGES.subscribePlus;

  return (
    <div
      className={`relative bg-slate-800 border rounded-2xl p-5 flex flex-col gap-4 ${
        recommended ? 'border-blue-600 ring-1 ring-blue-600/40' : 'border-slate-700'
      }`}
    >
      {recommended && (
        <span className="absolute -top-3 left-4 px-2 py-0.5 rounded-full bg-blue-600 text-white text-xs font-semibold">
          {SUBSCRIPTION_MESSAGES.recommendedBadge}
        </span>
      )}

      <div>
        <h3 className="text-base font-semibold text-slate-100">{plan.name}</h3>
        <p className="mt-1">
          <span className="text-2xl font-bold text-slate-100">{formatPriceBRL(plan.priceCents)}</span>
          <span className="text-sm font-normal text-slate-400"> /mês</span>
        </p>
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

      <button
        type="button"
        onClick={() => onSubscribe(plan)}
        className="w-full px-4 py-2.5 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors"
      >
        {subscribeLabel}
      </button>
    </div>
  );
}
