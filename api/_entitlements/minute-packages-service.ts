/**
 * SERVER-ONLY: central read of the conversation_minute_packages catalog —
 * the dashboard-published (ingles-dashboad) source of truth for purchasable
 * extra-minutes packages (see supabase/migrations/
 * 20260727230000_conversation_minute_packages_catalog.sql). Never trusts a
 * plan or package id from the client; every filter (active, published,
 * plan-compatible) is applied here, against rows fetched with the shared
 * service-role client, before anything reaches the response.
 *
 * Scope: read + eligibility only. Does not implement checkout, pricing
 * acknowledgement, Apple/Google IAP, or redemption into
 * user_conversation_credits — those stay out of scope until explicitly
 * requested (same posture as user_conversation_credits' own "apenas o
 * ledger, sem checkout" comment).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface MinutePackage {
  id: string;
  code: string;
  name: string;
  description: string | null;
  minutes: number;
  priceCents: number;
  currency: string;
  appleProductId: string | null;
  googleProductId: string | null;
}

interface MinutePackageRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  minutes: number;
  price_cents: number;
  currency: string;
  compatible_plan_codes: string[] | null;
  apple_product_id: string | null;
  google_product_id: string | null;
}

// NULL/empty compatible_plan_codes means "compatible with any plan that has
// purchases enabled at all" — the plan-level gate itself
// (conversation.extra_purchase_enabled, never the trial plan) is resolved by
// the caller via plan-entitlements-service.ts, not here. A non-empty list is
// an ADDITIONAL per-package restriction on top of that gate, never a
// replacement for it.
function isCompatibleWithPlan(compatiblePlanCodes: string[] | null, planCode: string | null): boolean {
  if (!compatiblePlanCodes || compatiblePlanCodes.length === 0) return true;
  return planCode !== null && compatiblePlanCodes.includes(planCode);
}

/**
 * Returns only packages that are active, published, and compatible with
 * planCode — ordered by display_order. Callers own the plan-level
 * purchaseAvailable gate (conversation.extra_purchase_enabled, and always
 * false for the trial plan) — this function only filters the catalog
 * itself; it never resolves entitlements and never grants access on its own.
 */
export async function listPublishedMinutePackages(
  supabase: SupabaseClient,
  planCode: string | null,
): Promise<MinutePackage[]> {
  const { data, error } = await supabase
    .from('conversation_minute_packages')
    .select(
      'id, code, name, description, minutes, price_cents, currency, compatible_plan_codes, apple_product_id, google_product_id',
    )
    .eq('active', true)
    .eq('status', 'published')
    .order('display_order', { ascending: true });

  if (error) throw new Error(`conversation_minute_packages read failed: ${error.message}`);

  const rows = (data ?? []) as MinutePackageRow[];
  return rows
    .filter((row) => isCompatibleWithPlan(row.compatible_plan_codes, planCode))
    .map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      description: row.description,
      minutes: row.minutes,
      priceCents: row.price_cents,
      currency: row.currency,
      // Null until the dashboard configures the package for sale in that
      // store (see 20260802215100_conversation_minute_packages_store_ids.sql)
      // — never invented or defaulted to an empty string here.
      appleProductId: row.apple_product_id,
      googleProductId: row.google_product_id,
    }));
}
