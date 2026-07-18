/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 *
 * Budget checks (Etapa 11, Fase 7). Reads limits from ai_runtime_controls'
 * pre-existing daily_budget_usd/monthly_budget_usd columns (part of the
 * foundation migration, always NULL = unlimited today — no plan hardcoded
 * here, no value invented). NULL at any scope means unlimited at that
 * scope; a budget only applies once an administrator sets one.
 *
 * Spend is read from usage_daily (already-reconciled, per-day aggregates —
 * raw ai_usage_events remain the source of truth; usage_daily is its
 * derived, reconciliable projection) plus currently-pending reservations'
 * estimated_cost_usd, so a burst of concurrent in-flight calls is counted
 * even before their events are durably recorded — "considerar consumo
 * committed + reservas ativas."
 *
 * All arithmetic goes through decimal.ts (exact NUMERIC-equivalent
 * BigInt-rational math) — never a binary float.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSharedServiceClient } from './usage-repository';
import { addRational, decimalToRational, rationalToDecimalString, type Rational } from './decimal';

export type BudgetScope = 'global' | 'provider' | 'feature' | 'user';
export type BudgetPeriod = 'day' | 'month';

export interface BudgetCheckParams {
  scope: BudgetScope;
  scopeKey: string; // 'global' | provider name | featureKey | userId
  period: BudgetPeriod;
  limitUsd: string | null; // from ai_runtime_controls; null = unlimited
  additionalEstimatedCostUsd: string | null; // this call's own not-yet-reserved estimate
}

export interface BudgetCheckResult {
  withinBudget: boolean;
  limitUsd: string | null;
  spentUsd: string;
  remainingUsd: string | null; // null when unlimited
}

function dayBoundsUtc(now: Date): { from: string; to: string } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

function monthBoundsUtc(now: Date): { from: string; to: string } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export interface BudgetCheckerInterface {
  check(params: BudgetCheckParams, now: Date): Promise<BudgetCheckResult>;
}

export class SupabaseBudgetChecker implements BudgetCheckerInterface {
  private readonly supabase: SupabaseClient;

  constructor(supabase?: SupabaseClient) {
    this.supabase = supabase ?? getSharedServiceClient();
  }

  async check(params: BudgetCheckParams, now: Date): Promise<BudgetCheckResult> {
    if (params.limitUsd === null) {
      return { withinBudget: true, limitUsd: null, spentUsd: '0', remainingUsd: null };
    }

    const { from, to } = params.period === 'day' ? dayBoundsUtc(now) : monthBoundsUtc(now);

    let query = this.supabase
      .from('usage_daily')
      .select('calculated_cost_usd')
      .gte('usage_date', from)
      .lt('usage_date', to);

    if (params.scope === 'provider') query = query.eq('provider', params.scopeKey);
    if (params.scope === 'feature') query = query.eq('feature_key', params.scopeKey);
    if (params.scope === 'user') query = query.eq('user_id', params.scopeKey);
    // 'global' scope applies no extra filter — sums every row in the window.

    const { data, error } = await query;
    if (error) throw new Error(`budget usage_daily query failed: ${error.message}`);

    let spent: Rational = decimalToRational('0');
    for (const row of (data ?? []) as Array<{ calculated_cost_usd: string | number | null }>) {
      if (row.calculated_cost_usd === null) continue;
      spent = addRational(spent, decimalToRational(String(row.calculated_cost_usd)));
    }

    // Pending reservations count toward the budget too, so N concurrent
    // requests against the last dollar of budget can't all pass the check
    // before any of them commits.
    let reservationQuery = this.supabase
      .from('usage_reservations')
      .select('estimated_cost_usd, feature_key, user_id')
      .eq('status', 'pending')
      .not('estimated_cost_usd', 'is', null);
    if (params.scope === 'feature') reservationQuery = reservationQuery.eq('feature_key', params.scopeKey);
    if (params.scope === 'user') reservationQuery = reservationQuery.eq('user_id', params.scopeKey);
    const { data: pendingReservations } = await reservationQuery;
    for (const row of (pendingReservations ?? []) as Array<{ estimated_cost_usd: string | number | null }>) {
      if (row.estimated_cost_usd === null) continue;
      spent = addRational(spent, decimalToRational(String(row.estimated_cost_usd)));
    }

    if (params.additionalEstimatedCostUsd !== null) {
      spent = addRational(spent, decimalToRational(params.additionalEstimatedCostUsd));
    }

    const spentStr = rationalToDecimalString(spent);
    const limitRational = decimalToRational(params.limitUsd);
    const withinBudget = spent.num * limitRational.den <= limitRational.num * spent.den; // spent <= limit, exact rational compare
    const remaining = withinBudget
      ? rationalToDecimalString({ num: limitRational.num * spent.den - spent.num * limitRational.den, den: limitRational.den * spent.den })
      : '0';

    return { withinBudget, limitUsd: params.limitUsd, spentUsd: spentStr, remainingUsd: remaining };
  }
}
