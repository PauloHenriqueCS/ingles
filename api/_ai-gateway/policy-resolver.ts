/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 *
 * Resolves the effective gateway policy for a given call context.
 * Scope hierarchy (most to least general): global → provider → feature → user.
 *
 * gateway_mode: most specific scope wins.
 * runtime_status: most restrictive across all applicable scopes wins;
 *   a lower scope cannot re-enable what a higher scope disabled.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServiceCredentials } from '../_env';
import type { GatewayCallContext, GatewayPolicy, GatewayMode, RuntimeStatus } from './types';

// ── Status severity ───────────────────────────────────────────────────────────

// Etapa 11 added circuit_open/maintenance to RuntimeStatus (types.ts).
// Placed so that an explicit admin action (disabled, maintenance) always
// outranks an automatic one (circuit_open, paused_automatically) when scopes
// disagree — a human override should never be silently re-opened by a stale
// automatic status at a broader scope.
const STATUS_SEVERITY: Record<RuntimeStatus, number> = {
  enabled:              1,
  cache_only:           2,
  circuit_open:         3,
  paused_automatically: 4,
  maintenance:          5,
  disabled:             6,
};

function mostRestrictiveStatus(statuses: RuntimeStatus[]): RuntimeStatus {
  if (statuses.length === 0) return 'enabled';
  return statuses.reduce<RuntimeStatus>(
    (worst, s) => STATUS_SEVERITY[s] > STATUS_SEVERITY[worst] ? s : worst,
    'enabled',
  );
}

// ── Mode resolution ───────────────────────────────────────────────────────────
// Returns the most specific (innermost) gateway_mode available.

const SCOPE_PRIORITY = ['user', 'feature', 'provider', 'global'] as const;

function mostSpecificMode(
  rows: Array<{ scope_type: string; gateway_mode: string }>,
): GatewayMode {
  for (const scope of SCOPE_PRIORITY) {
    const row = rows.find(r => r.scope_type === scope);
    if (row) return row.gateway_mode as GatewayMode;
  }
  return 'legacy';
}

// ── Budget/limit field resolution ─────────────────────────────────────────────

type ScopedControlRow = {
  scope_type: string;
  gateway_mode: string;
  runtime_status: string;
  daily_budget_usd: string | number | null;
  monthly_budget_usd: string | number | null;
  max_concurrent_requests: number | null;
  rate_limit_requests: number | null;
  rate_limit_window_seconds: number | null;
};

// Per-field fallback: the most specific row that actually HAS this field
// set wins, independently for each field — not "the most specific row
// overall" (mostSpecificMode's approach, correct for gateway_mode because
// every row always has one, but wrong here). Every scope already has a
// seeded ai_runtime_controls row for gateway_mode purposes, so a
// feature/provider row that exists but was never given its own budget/limit
// must not shadow a value configured only at a broader scope (typically
// 'global') just because that row happens to exist.
function mostSpecificFieldValue<K extends keyof ScopedControlRow>(
  rows: ScopedControlRow[], key: K,
): ScopedControlRow[K] | null {
  for (const scope of SCOPE_PRIORITY) {
    const row = rows.find(r => r.scope_type === scope);
    if (row && row[key] != null) return row[key];
  }
  return null;
}

// Same precedence as mostSpecificFieldValue, but also reports WHICH scope
// produced the winning value — a budget field resolved from a 'global' (or
// 'provider') row must be reserved against that ONE shared bucket, never
// silently re-labeled as if it were configured per-feature (see
// enforcement.ts's buildBudgetScopes, which consumes this).
function mostSpecificFieldValueWithScope<K extends keyof ScopedControlRow>(
  rows: ScopedControlRow[], key: K,
): { value: NonNullable<ScopedControlRow[K]>; scopeType: (typeof SCOPE_PRIORITY)[number] } | null {
  for (const scope of SCOPE_PRIORITY) {
    const row = rows.find(r => r.scope_type === scope);
    if (row && row[key] != null) return { value: row[key] as NonNullable<ScopedControlRow[K]>, scopeType: scope };
  }
  return null;
}

// ── In-memory policy cache ────────────────────────────────────────────────────

const DEFAULT_TTL_MS = 5_000;

interface CacheEntry {
  policy: GatewayPolicy;
  expiresAt: number;
}

export interface PolicyResolverInterface {
  resolvePolicy(context: GatewayCallContext): Promise<GatewayPolicy>;
  invalidate(): void;
}

// ── Service role client factory ───────────────────────────────────────────────

function createServiceClient(): SupabaseClient | null {
  const { url, key } = getSupabaseServiceCredentials();
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ── GatewayPolicyResolver ─────────────────────────────────────────────────────

export class GatewayPolicyResolver implements PolicyResolverInterface {
  private readonly supabase: SupabaseClient | null;
  private readonly ttlMs: number;
  private readonly clock: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(supabase?: SupabaseClient | null, ttlMs = DEFAULT_TTL_MS, clock: () => number = Date.now) {
    this.supabase = supabase !== undefined ? supabase : createServiceClient();
    this.ttlMs = ttlMs;
    this.clock = clock;
  }

  async resolvePolicy(context: GatewayCallContext): Promise<GatewayPolicy> {
    const cacheKey = this.buildCacheKey(context);
    const cached = this.cache.get(cacheKey);
    if (cached && this.clock() < cached.expiresAt) {
      return cached.policy;
    }

    let policy: GatewayPolicy;
    try {
      policy = await this.fetchPolicy(context);
    } catch {
      // On failure, use the last known valid policy or a safe default.
      if (cached) return cached.policy;
      return { gatewayMode: 'legacy', runtimeStatus: 'enabled' };
    }

    this.cache.set(cacheKey, { policy, expiresAt: this.clock() + this.ttlMs });
    return policy;
  }

  invalidate(): void {
    this.cache.clear();
  }

  private buildCacheKey(context: GatewayCallContext): string {
    return `${context.featureKey}|${context.provider}|${context.userId ?? ''}`;
  }

  private async fetchPolicy(context: GatewayCallContext): Promise<GatewayPolicy> {
    const client = this.supabase;
    if (!client) {
      // No database configured — fail-safe default.
      return { gatewayMode: 'legacy', runtimeStatus: 'enabled' };
    }

    // Fetch all applicable scope rows in one round trip.
    const scopeFilters: Array<{ scope_type: string; scope_key: string }> = [
      { scope_type: 'global',   scope_key: 'global' },
      { scope_type: 'provider', scope_key: context.provider },
      { scope_type: 'feature',  scope_key: context.featureKey },
    ];
    if (context.userId) {
      scopeFilters.push({ scope_type: 'user', scope_key: context.userId });
    }

    const { data, error } = await client
      .from('ai_runtime_controls')
      .select('scope_type, gateway_mode, runtime_status, daily_budget_usd, monthly_budget_usd, max_concurrent_requests, rate_limit_requests, rate_limit_window_seconds')
      .or(
        scopeFilters
          .map(f => `and(scope_type.eq.${f.scope_type},scope_key.eq.${f.scope_key})`)
          .join(','),
      );

    if (error || !data) {
      throw new Error(`Failed to fetch policy: ${error?.message ?? 'no data'}`);
    }

    const rows = data as ScopedControlRow[];

    const gatewayMode = mostSpecificMode(rows);
    const runtimeStatus = mostRestrictiveStatus(
      rows.map(r => r.runtime_status as RuntimeStatus),
    );
    // Etapa 11 budget-enforcement correction: resolved per-field (see
    // mostSpecificFieldValue above), not by picking one whole "most
    // specific" row — a feature/provider row with no budget of its own must
    // not shadow a budget set only at a broader scope (typically 'global').
    const dailyBudget = mostSpecificFieldValueWithScope(rows, 'daily_budget_usd');
    const monthlyBudget = mostSpecificFieldValueWithScope(rows, 'monthly_budget_usd');

    return {
      gatewayMode,
      runtimeStatus,
      dailyBudgetUsd:          dailyBudget != null ? String(dailyBudget.value) : null,
      monthlyBudgetUsd:        monthlyBudget != null ? String(monthlyBudget.value) : null,
      dailyBudgetScopeType:    dailyBudget?.scopeType ?? null,
      monthlyBudgetScopeType:  monthlyBudget?.scopeType ?? null,
      maxConcurrentRequests:  mostSpecificFieldValue(rows, 'max_concurrent_requests'),
      rateLimitRequests:      mostSpecificFieldValue(rows, 'rate_limit_requests'),
      rateLimitWindowSeconds: mostSpecificFieldValue(rows, 'rate_limit_window_seconds'),
    };
  }
}
