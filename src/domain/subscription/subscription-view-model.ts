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
 *
 * showManageButton/showRestoreButton are read directly from
 * state.canManageSubscription/canRestorePurchases — never hardcoded by
 * status or plan name — so the screen is already wired for whenever a real
 * store integration (RevenueCat) starts returning true for either. Both are
 * false today for every access type, including 'commercial'.
 */
export function buildSubscriptionViewModel(state: SubscriptionScreenState, now: Date = new Date()): SubscriptionViewModel {
  // accessType 'internal' is checked before the status switch: it is
  // orthogonal to status (an internal assignment normally resolves
  // status==='active', since it has no cancellation/billing-issue
  // plumbing), but needs entirely different copy — no billing/renewal
  // language, no store CTAs, never the commercial "Assinatura ativa" wording.
  if (state.accessType === 'internal') {
    return {
      status: state.status,
      headline: SUBSCRIPTION_MESSAGES.internalTitle,
      subheadline: SUBSCRIPTION_MESSAGES.internalComplementaryNote,
      trialDaysRemainingLabel: null,
      trialEndsAtLabel: null,
      currentPlanName: state.currentPlanName,
      activeStatusLabel: SUBSCRIPTION_MESSAGES.internalStatusLabel,
      renewalLabel: null,
      canceledPlanName: null,
      accessEndsAtLabel: null,
      showTrialLimits: false,
      showPlanCards: false,
      showManageButton: state.canManageSubscription,
      showRestoreButton: state.canRestorePurchases,
    };
  }

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
        showManageButton: state.canManageSubscription,
        showRestoreButton: state.canRestorePurchases,
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
        // Null (never a placeholder string) when unknown — the screen omits
        // the renewal line entirely rather than claim it's "unavailable".
        renewalLabel: state.subscriptionExpiresAt ? formatDatePtBr(state.subscriptionExpiresAt) : null,
        canceledPlanName: null,
        accessEndsAtLabel: null,
        showTrialLimits: false,
        showPlanCards: false,
        showManageButton: state.canManageSubscription,
        showRestoreButton: state.canRestorePurchases,
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
        showManageButton: state.canManageSubscription,
        showRestoreButton: state.canRestorePurchases,
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
        showManageButton: state.canManageSubscription,
        showRestoreButton: state.canRestorePurchases,
      };
    }

    case 'billing_issue': {
      return {
        status: 'billing_issue',
        headline: SUBSCRIPTION_MESSAGES.billingIssueTitle,
        subheadline: SUBSCRIPTION_MESSAGES.billingIssueSubtitle,
        trialDaysRemainingLabel: null,
        trialEndsAtLabel: null,
        currentPlanName: state.currentPlanName,
        activeStatusLabel: null,
        renewalLabel: null,
        canceledPlanName: null,
        accessEndsAtLabel: state.subscriptionExpiresAt ? formatDatePtBr(state.subscriptionExpiresAt) : null,
        showTrialLimits: false,
        showPlanCards: false,
        showManageButton: state.canManageSubscription,
        showRestoreButton: state.canRestorePurchases,
      };
    }
  }
}
