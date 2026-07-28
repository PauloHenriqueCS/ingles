import type { SubscriptionScreenState } from './subscription-types';
import { computeDaysRemaining, formatDatePtBr, formatTrialDaysRemainingLabel } from './subscription-formatting';
import { SUBSCRIPTION_MESSAGES } from './subscription-copy';

export interface SubscriptionViewModel {
  status: SubscriptionScreenState['status'];
  headline: string;
  subheadline: string | null;
  /** trialing only */
  trialDaysRemainingLabel: string | null;
  trialEndsAtLabel: string | null;
  /** active only */
  currentPlanName: string | null;
  activeStatusLabel: string | null;
  renewalLabel: string | null;
  /** canceled only */
  canceledPlanName: string | null;
  accessEndsAtLabel: string | null;
  /** UI affordances */
  showTrialLimits: boolean;
  showPlanCards: boolean;
  showManageButton: boolean;
  showRestoreButton: boolean;
}

/**
 * The single place that turns raw subscription state into what the screen
 * renders. Mirrors ../entitlements/compute-feature-state.ts — never derive
 * display strings ad-hoc inside SubscriptionView.
 */
export function buildSubscriptionViewModel(state: SubscriptionScreenState, now: Date = new Date()): SubscriptionViewModel {
  switch (state.status) {
    case 'trialing': {
      const days = state.trialEndsAt ? computeDaysRemaining(state.trialEndsAt, now) : (state.trialDaysRemaining ?? 0);
      return {
        status: 'trialing',
        headline: SUBSCRIPTION_MESSAGES.trialingTitle,
        subheadline: null,
        trialDaysRemainingLabel: formatTrialDaysRemainingLabel(days),
        trialEndsAtLabel: state.trialEndsAt ? formatDatePtBr(state.trialEndsAt) : null,
        currentPlanName: null,
        activeStatusLabel: null,
        renewalLabel: null,
        canceledPlanName: null,
        accessEndsAtLabel: null,
        showTrialLimits: true,
        showPlanCards: false,
        showManageButton: false,
        showRestoreButton: true,
      };
    }

    case 'active': {
      return {
        status: 'active',
        headline: state.currentPlanName ?? '—',
        subheadline: null,
        trialDaysRemainingLabel: null,
        trialEndsAtLabel: null,
        currentPlanName: state.currentPlanName,
        activeStatusLabel: SUBSCRIPTION_MESSAGES.activeStatusLabel,
        renewalLabel: state.subscriptionExpiresAt
          ? formatDatePtBr(state.subscriptionExpiresAt)
          : SUBSCRIPTION_MESSAGES.activeRenewalUnavailable,
        canceledPlanName: null,
        accessEndsAtLabel: null,
        showTrialLimits: false,
        showPlanCards: false,
        showManageButton: true,
        showRestoreButton: true,
      };
    }

    case 'expired': {
      return {
        status: 'expired',
        headline: SUBSCRIPTION_MESSAGES.expiredTitle,
        subheadline: SUBSCRIPTION_MESSAGES.expiredSubtitle,
        trialDaysRemainingLabel: null,
        trialEndsAtLabel: null,
        currentPlanName: null,
        activeStatusLabel: null,
        renewalLabel: null,
        canceledPlanName: null,
        accessEndsAtLabel: null,
        showTrialLimits: false,
        showPlanCards: true,
        showManageButton: false,
        showRestoreButton: true,
      };
    }

    case 'canceled': {
      return {
        status: 'canceled',
        headline: SUBSCRIPTION_MESSAGES.canceledTitle,
        subheadline: SUBSCRIPTION_MESSAGES.canceledChooseAgainNote,
        trialDaysRemainingLabel: null,
        trialEndsAtLabel: null,
        currentPlanName: null,
        activeStatusLabel: null,
        renewalLabel: null,
        canceledPlanName: state.currentPlanName,
        accessEndsAtLabel: state.subscriptionExpiresAt
          ? formatDatePtBr(state.subscriptionExpiresAt)
          : SUBSCRIPTION_MESSAGES.canceledAccessEndedNote,
        showTrialLimits: false,
        showPlanCards: true,
        showManageButton: false,
        showRestoreButton: true,
      };
    }
  }
}
