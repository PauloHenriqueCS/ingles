import type { CommercialPlanCode, CommercialPlanDisplay, TrialDailyLimits } from './subscription-types';

/** The 7-day free trial's daily/lifetime activity limits. Shown on the trialing state. */
export const TRIAL_DAILY_LIMITS: TrialDailyLimits = {
  writingPerDay: 1,
  pronunciationPerDay: 1,
  listeningPerDay: 1,
  conversationMinutesTotal: 15,
};

export const TRIAL_DURATION_DAYS = 7;

/**
 * The two commercial plans. Prices and daily limits are product-defined and
 * final.
 */
export const COMMERCIAL_PLANS: Record<CommercialPlanCode, CommercialPlanDisplay> = {
  essential: {
    code: 'essential',
    name: 'Essencial',
    priceCents: 3490,
    writingPerDay: 1,
    pronunciationPerDay: 1,
    listeningPerDay: 1,
    conversationMinutesMonthly: 30,
    allowsExtraMinutePackages: true,
  },
  plus: {
    code: 'plus',
    name: 'Plus',
    priceCents: 5990,
    writingPerDay: 3,
    pronunciationPerDay: 3,
    listeningPerDay: 3,
    conversationMinutesMonthly: 70,
    allowsExtraMinutePackages: true,
  },
};

export const RECOMMENDED_PLAN_CODE: CommercialPlanCode = 'plus';

export const COMMERCIAL_PLAN_ORDER: CommercialPlanCode[] = ['essential', 'plus'];
