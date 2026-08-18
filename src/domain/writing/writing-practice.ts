/**
 * Pure gate for offering a NEW writing practice ("Nova missão") after a completed
 * one. The decision is SERVER-AUTHORITATIVE: it reads the plan entitlement
 * (writing.reviews.canStart, computed from today's consumption vs the plan
 * limit), never a client-side counter. The backend (reserve_writing_review)
 * re-checks the limit before any AI call, so this only governs whether the UI
 * offers the action — the frontend can never bypass the limit.
 *
 * Kept independent of any commercial-vs-curricular concern: how many writings the
 * plan allows (this gate) is a different axis from what a recorte requires
 * (curriculum engine). Extra writings are allowed by quota and are a curricular
 * no-op once the modality is already practiced.
 */
import type { WritingEntitlements } from '../entitlements/entitlement-types';

export function canOfferNewWriting(
  entitlements: WritingEntitlements | null,
  disabledByPlan: boolean,
): boolean {
  if (disabledByPlan) return false;
  if (!entitlements || !entitlements.enabled) return false;
  return entitlements.reviews.canStart === true;
}
