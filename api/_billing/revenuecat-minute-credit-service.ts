/**
 * SERVER-ONLY: credits a consumable minute-package purchase
 * (NON_RENEWING_PURCHASE events) into public.user_conversation_credits —
 * the same ledger api/_entitlements/plan-entitlements-service.ts already
 * reads for extraSecondsAvailable. No new ledger table.
 *
 * Idempotency: source='purchase' + external_reference=transactionId is
 * enforced by a real DB-level partial unique index
 * (uq_user_conversation_credits_external_reference — see
 * 20260803233000_revenuecat_webhook_events.sql), not just an
 * application-level check-then-insert, so a webhook retry racing a
 * previous delivery can never double-credit. A unique-violation on insert
 * (Postgres 23505) is treated as an idempotent no-op success, matching the
 * exact convention already used by
 * api/_account/billing-block-repository.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSharedServiceClient } from '../_ai-gateway/usage-repository';
import { isValidUuid } from './revenuecat-subscription-sync-service';
import { isSandboxBlockedHere } from './revenuecat-environment';

export interface RevenueCatConsumablePurchaseEvent {
  appUserId: string;
  environment: string;
  productId: string;
  transactionId: string | null;
}

export type CreditOutcome =
  | { ok: true; action: 'credited' | 'already_credited'; minutes?: number }
  | {
      ok: false;
      reason:
        | 'invalid_app_user_id'
        | 'missing_transaction_id'
        | 'unknown_product'
        | 'package_not_active'
        | 'trial_not_allowed'
        | 'sandbox_blocked_in_production';
    };

interface EffectivePlanRow {
  plan_code: string | null;
}

export async function creditMinutePackagePurchase(
  purchase: RevenueCatConsumablePurchaseEvent,
  deps?: { supabase?: SupabaseClient; now?: Date },
): Promise<CreditOutcome> {
  const supabase = deps?.supabase ?? getSharedServiceClient();
  const now = deps?.now ?? new Date();

  if (isSandboxBlockedHere(purchase.environment)) {
    return { ok: false, reason: 'sandbox_blocked_in_production' };
  }
  if (!isValidUuid(purchase.appUserId)) {
    return { ok: false, reason: 'invalid_app_user_id' };
  }
  if (!purchase.transactionId) {
    return { ok: false, reason: 'missing_transaction_id' };
  }

  // Never by plan name — matches the same rule for subscription products
  // (FASE 12: "mapear pelo Apple Product ID salvo em
  // conversation_minute_packages").
  const { data: pkg, error: pkgError } = await supabase
    .from('conversation_minute_packages')
    .select('minutes, active, status')
    .eq('apple_product_id', purchase.productId)
    .maybeSingle();
  if (pkgError) throw new Error(`conversation_minute_packages lookup failed: ${pkgError.message}`);
  if (!pkg) return { ok: false, reason: 'unknown_product' };

  const packageRow = pkg as { minutes: number; active: boolean; status: string };
  if (!packageRow.active || packageRow.status !== 'published') {
    return { ok: false, reason: 'package_not_active' };
  }

  // "trial não pode comprar pacote" — resolved server-side from the same
  // RPC entitlements/enforcement already trusts, never from client input.
  const { data: planRowsRaw, error: planError } = await supabase.rpc('admin_resolve_effective_plan_v1', {
    p_user_id: purchase.appUserId,
    p_at: now.toISOString(),
  });
  if (planError) throw new Error(`admin_resolve_effective_plan_v1 failed: ${planError.message}`);
  const plan = (Array.isArray(planRowsRaw) ? planRowsRaw[0] : planRowsRaw) as EffectivePlanRow | undefined;
  if (plan?.plan_code === 'trial') {
    return { ok: false, reason: 'trial_not_allowed' };
  }

  const totalSeconds = packageRow.minutes * 60;
  const { error: insertError } = await supabase.from('user_conversation_credits').insert({
    user_id: purchase.appUserId,
    total_seconds: totalSeconds,
    remaining_seconds: totalSeconds,
    source: 'purchase',
    external_reference: purchase.transactionId,
    created_by: purchase.appUserId,
  });

  if (insertError) {
    if ((insertError as { code?: string }).code === '23505') {
      return { ok: true, action: 'already_credited' };
    }
    throw new Error(`user_conversation_credits insert failed: ${insertError.message}`);
  }

  return { ok: true, action: 'credited', minutes: packageRow.minutes };
}
