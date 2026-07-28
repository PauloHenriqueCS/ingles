import { useState } from 'react';
import { ArrowLeft, Clock, CheckCircle2, AlertTriangle, Ban, RotateCcw, Settings2 } from 'lucide-react';
import { AppIcon } from './AppIcon';
import SubscriptionPlanCard from './SubscriptionPlanCard';
import type { CommercialPlanDisplay, SubscriptionAccessStatus } from '../domain/subscription/subscription-types';
import { COMMERCIAL_PLAN_ORDER, COMMERCIAL_PLANS, RECOMMENDED_PLAN_CODE, TRIAL_DAILY_LIMITS } from '../domain/subscription/subscription-plans';
import { SUBSCRIPTION_MESSAGES, TRIAL_LIMIT_LABELS } from '../domain/subscription/subscription-copy';
import { getMockSubscriptionState, MOCK_STATUS_OPTIONS } from '../domain/subscription/subscription-mock-data';
import { buildSubscriptionViewModel } from '../domain/subscription/subscription-view-model';

interface Props {
  onBack: () => void;
  /** Testing/dev only — which mock state to render initially. Defaults to 'trialing'. */
  initialStatus?: SubscriptionAccessStatus;
}

const STATUS_ICON = {
  trialing: Clock,
  active: CheckCircle2,
  expired: AlertTriangle,
  canceled: Ban,
} as const;

const STATUS_SWITCHER_LABEL: Record<SubscriptionAccessStatus, string> = {
  trialing: 'Teste ativo',
  active: 'Ativa',
  expired: 'Expirado',
  canceled: 'Cancelada',
};

export default function SubscriptionView({ onBack, initialStatus = 'trialing' }: Props) {
  const [mockStatus, setMockStatus] = useState<SubscriptionAccessStatus>(initialStatus);
  const state = getMockSubscriptionState(mockStatus);
  const vm = buildSubscriptionViewModel(state);
  const StatusIcon = STATUS_ICON[vm.status];

  function handleSubscribe(plan: CommercialPlanDisplay) {
    window.alert(SUBSCRIPTION_MESSAGES.devPurchasePlaceholder(plan.name));
  }

  function handleRestore() {
    window.alert(SUBSCRIPTION_MESSAGES.devRestorePlaceholder);
  }

  function handleManage() {
    window.alert(SUBSCRIPTION_MESSAGES.devManageSubscriptionPlaceholder);
  }

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
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

      <div className="flex-1 overflow-auto p-4 max-w-2xl mx-auto w-full space-y-5 pb-10">

        {import.meta.env.DEV && (
          <section className="bg-amber-950/20 border border-amber-900/40 rounded-xl p-3 space-y-2" data-testid="dev-status-switcher">
            <p className="text-xs text-amber-300 font-medium uppercase tracking-wider">Desenvolvimento — visualizar estado</p>
            <div className="flex flex-wrap gap-2">
              {MOCK_STATUS_OPTIONS.map((status) => (
                <button
                  key={status}
                  type="button"
                  onClick={() => setMockStatus(status)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    status === mockStatus
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
              <p className="text-xs text-slate-500">Próxima renovação: {vm.renewalLabel}</p>
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
            {COMMERCIAL_PLAN_ORDER.map((code) => (
              <SubscriptionPlanCard
                key={code}
                plan={COMMERCIAL_PLANS[code]}
                recommended={code === RECOMMENDED_PLAN_CODE}
                onSubscribe={handleSubscribe}
              />
            ))}
          </section>
        )}

        <section className="space-y-2.5 pt-2">
          {vm.showManageButton && (
            <button
              type="button"
              onClick={handleManage}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-slate-800 border border-slate-700 hover:bg-slate-700 text-slate-200 transition-colors"
            >
              <AppIcon icon={Settings2} className="w-4 h-4 shrink-0" />
              {SUBSCRIPTION_MESSAGES.manageSubscription}
            </button>
          )}

          {vm.showRestoreButton && (
            <button
              type="button"
              onClick={handleRestore}
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
