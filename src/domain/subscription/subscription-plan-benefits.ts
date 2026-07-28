import type { CommercialPlanDisplay } from './subscription-types';
import { PLAN_BENEFIT_LABELS, SUBSCRIPTION_MESSAGES } from './subscription-copy';

/**
 * Ordered benefit lines for a plan card. When a plan hasn't defined its
 * monthly conversation minutes (conversationMinutesMonthly === null), the
 * "a definir" placeholder is only appended when `includeDevOnlyNote` is
 * true — pass `import.meta.env.DEV` from the caller. Defaults to false so a
 * production build never shows it even if the caller forgets to pass it,
 * and so this plan never silently invents a number for the user.
 */
export function buildPlanBenefitLines(plan: CommercialPlanDisplay, includeDevOnlyNote = false): string[] {
  const lines = [
    PLAN_BENEFIT_LABELS.writingPerDay(plan.writingPerDay),
    PLAN_BENEFIT_LABELS.pronunciationPerDay(plan.pronunciationPerDay),
    PLAN_BENEFIT_LABELS.listeningPerDay(plan.listeningPerDay),
  ];

  if (plan.conversationMinutesMonthly !== null) {
    lines.push(PLAN_BENEFIT_LABELS.conversationMinutesMonthly(plan.conversationMinutesMonthly));
  } else if (includeDevOnlyNote) {
    lines.push(SUBSCRIPTION_MESSAGES.conversationMinutesTbdDev);
  }

  return lines;
}
