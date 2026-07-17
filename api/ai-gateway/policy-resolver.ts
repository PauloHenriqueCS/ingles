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
import type { GatewayCallContext, GatewayPolicy, GatewayMode, RuntimeStatus } from './types';

// ── Status severity ───────────────────────────────────────────────────────────

const STATUS_SEVERITY: Record<RuntimeStatus, number> = {
  enabled:              1,
  cache_only:           2,
  paused_automatically: 3,
  disabled:             4,
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

// ── In-memory policy cache ────────────────────────────────────────────────────

const DEFAULT_TTL_MS = 30_000;

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
  const url = process.env.VITE_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ── GatewayPolicyResolver ─────────────────────────────────────────────────────

export class GatewayPolicyResolver implements PolicyResolverInterface {
  private readonly supabase: SupabaseClient | null;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(supabase?: SupabaseClient | null, ttlMs = DEFAULT_TTL_MS) {
    this.supabase = supabase !== undefined ? supabase : createServiceClient();
    this.ttlMs = ttlMs;
  }

  async resolvePolicy(context: GatewayCallContext): Promise<GatewayPolicy> {
    const cacheKey = this.buildCacheKey(context);
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
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

    this.cache.set(cacheKey, { policy, expiresAt: Date.now() + this.ttlMs });
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
      .select('scope_type, gateway_mode, runtime_status')
      .or(
        scopeFilters
          .map(f => `and(scope_type.eq.${f.scope_type},scope_key.eq.${f.scope_key})`)
          .join(','),
      );

    if (error || !data) {
      throw new Error(`Failed to fetch policy: ${error?.message ?? 'no data'}`);
    }

    const rows = data as Array<{
      scope_type: string;
      gateway_mode: string;
      runtime_status: string;
    }>;

    const gatewayMode = mostSpecificMode(rows);
    const runtimeStatus = mostRestrictiveStatus(
      rows.map(r => r.runtime_status as RuntimeStatus),
    );

    return { gatewayMode, runtimeStatus };
  }
}
