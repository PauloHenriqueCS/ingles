import type { SubscriptionAccessType } from './subscription-types';

/**
 * Pure gating rules for the native (iOS-only) store-management affordances
 * on the subscription screen — extracted out of SubscriptionView.tsx so the
 * rules are unit-testable without rendering a component (this repo's vitest
 * environment is 'node', no DOM/RTL — see package.json/vite.config.ts).
 *
 * Never a source of access truth (see subscription-status-service.ts) — this
 * only decides whether to SHOW a button, never whether the user has access.
 */

/** True only for a real commercial subscription assignment (active/canceled/
 *  billing_issue) or no assignment at all, on a platform where the native
 *  purchase SDK is actually running. The internal (hand-assigned) plan and
 *  the trial never involve RevenueCat at all, and web never runs the SDK. */
export function isNativeStoreSectionVisible(accessType: SubscriptionAccessType, nativeSupported: boolean): boolean {
  return nativeSupported && accessType !== 'internal' && accessType !== 'trial';
}

/**
 * "Gerenciar assinatura" must render ONLY when RevenueCat's own
 * CustomerInfo.managementURL (passed straight through from
 * revenueCatClient.ts, never a hardcoded App Store link — see
 * revenueCatTypes.ts's OrodimCustomerInfo.managementUrl doc comment) is a
 * real, non-empty string. No generic fallback URL exists anywhere in this
 * codebase; when managementUrl is null/undefined/empty, the button is
 * simply omitted — there is nothing else to show instead.
 */
export function shouldShowManageSubscriptionButton(
  accessType: SubscriptionAccessType,
  nativeSupported: boolean,
  managementUrl: string | null | undefined,
): boolean {
  return isNativeStoreSectionVisible(accessType, nativeSupported) && typeof managementUrl === 'string' && managementUrl.length > 0;
}
