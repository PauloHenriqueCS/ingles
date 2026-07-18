/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 *
 * Entitlement resolution (Etapa 11, Fase 1). Authorship lives entirely in
 * the dashboard's plan schema (plans, plan_versions, capability_definitions,
 * plan_capability_values, user_plan_assignments, user_capability_overrides,
 * user_access_controls) — this module only READS it, via the dashboard's
 * own existing SECURITY DEFINER function admin_resolve_effective_plan_v1
 * for plan/assignment/suspension resolution, plus direct read-only queries
 * for capability values and overrides (no equivalent single RPC returns the
 * final resolved value for one capability_key).
 *
 * Never accepts a planId from the client. Never returns administrative
 * fields (internal notes, pricing, other users' data) — only the technical
 * shape declared in EffectiveEntitlement (types.ts).
 *
 * Resolution order (Fase 1):
 *   1. actorType=system → bypass entirely, no plan involved.
 *   2. admin block (user_access_controls.is_suspended, read inside
 *      admin_resolve_effective_plan_v1) → allowed=false.
 *   3. active assignment (explicit, or the dashboard's own trial/promotional/
 *      subscription origins already modeled as assignments) → resolved
 *      plan_version.
 *   4. no assignment → dashboard's default active plan (is_default=true).
 *   5. no plan system data at all → source='no_plan_configured'.
 *   6. capability values from the resolved plan_version.
 *   7. active user_capability_overrides layered on top (add/replace/
 *      unlimited/disable), most specific operation wins per capability_key.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSharedServiceClient } from './usage-repository';
import { resolvePeriodBounds } from './periods';
import type { ActorType, AiFeatureKey, EffectiveEntitlement, EntitlementLimit } from './types';

// Maps this Gateway's feature/metric vocabulary to the dashboard's
// capability_definitions.key namespace. Additive: a feature with no mapping
// here simply has no configurable limit yet (treated as unlimited/legacy),
// matching "defaults novos devem ser ilimitados para não bloquear usuários
// existentes." Confirmed against the one real row seeded so far:
// 'conversation.realtime.seconds.monthly' (quota, unit=seconds, month).
// Exported (not just module-local) so the enforce-readiness preflight
// (scripts/ai-gateway-enforce-preflight.ts) can report which features have
// a configured capability mapping without duplicating this list and risking
// drift between the two.
export const CAPABILITY_KEY_BY_METRIC: Partial<Record<string, string>> = {
  'conversation.webrtc_connect:session_seconds':    'conversation.realtime.seconds.monthly',
  'conversation.realtime_usage:session_seconds':    'conversation.realtime.seconds.monthly',
};

function capabilityKeyFor(featureKey: string, metricKey: string): string | undefined {
  return CAPABILITY_KEY_BY_METRIC[`${featureKey}:${metricKey}`];
}

export interface EntitlementResolverInterface {
  resolve(userId: string | undefined, actorType: ActorType, featureKey: AiFeatureKey, metricKeys: string[]): Promise<EffectiveEntitlement>;
}

interface EffectivePlanRow {
  user_id: string;
  access_allowed: boolean;
  plan_id: string | null;
  plan_code: string | null;
  plan_name: string | null;
  plan_version_id: string | null;
  version_number: number | null;
  assignment_origin: string | null;
  assignment_id: string | null;
  is_suspended: boolean;
}

const PERIOD_VALUES = new Set(['none', 'request', 'day', 'week', 'month', 'lifetime', 'assignment_cycle']);

function toPeriod(v: unknown): EntitlementLimit['period'] {
  return typeof v === 'string' && PERIOD_VALUES.has(v) ? (v as EntitlementLimit['period']) : 'none';
}

// periodStart/resetAt(=periodEnd) for a resolved period — delegates to the
// shared periods.ts so this never diverges from what enforcement.ts passes
// into reserve_gateway_usage_v1's accumulated-quota bucket. assignmentWindow
// is only consulted for period='assignment_cycle'.
function periodBoundsFor(
  period: EntitlementLimit['period'], now: Date,
  assignmentWindow: { startsAt: string | null; endsAt: string | null } | null,
): { periodStart: string | null; resetAt: string | null } {
  const bounds = resolvePeriodBounds(period, now, assignmentWindow);
  if (!bounds) return { periodStart: null, resetAt: null };
  return { periodStart: bounds.periodStart, resetAt: bounds.periodEnd };
}

/** Extracts a numeric limit from capability_definitions'/overrides' jsonb `value`. Never throws on a malformed value — treats it as unlimited (fail-open, never a surprise block). */
function toNumericLimit(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'object' && value !== null && 'limit' in (value as Record<string, unknown>)) {
    const inner = (value as Record<string, unknown>).limit;
    return typeof inner === 'number' && Number.isFinite(inner) ? inner : null;
  }
  return null;
}

export class SupabaseEntitlementResolver implements EntitlementResolverInterface {
  private readonly supabase: SupabaseClient;
  private readonly cache = new Map<string, { entitlement: EffectiveEntitlement; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly clock: () => number;

  constructor(supabase?: SupabaseClient, ttlMs = 5_000, clock: () => number = Date.now) {
    this.supabase = supabase ?? getSharedServiceClient();
    this.ttlMs = ttlMs;
    this.clock = clock;
  }

  async resolve(
    userId: string | undefined,
    actorType: ActorType,
    featureKey: AiFeatureKey,
    metricKeys: string[],
  ): Promise<EffectiveEntitlement> {
    const now = new Date(this.clock());

    // actorType=system never involves a plan — Fase 1 requirement.
    if (actorType !== 'user' || !userId) {
      return {
        allowed: true,
        userId: null,
        actorType,
        featureKey,
        effectivePlanId: null,
        limits: metricKeys.map((metricKey) => ({ metricKey, limit: null, period: 'none', periodStart: null, resetAt: null })),
        source: 'system_actor',
        revision: null,
        resolvedAt: now.toISOString(),
      };
    }

    const cacheKey = `${userId}|${featureKey}|${metricKeys.join(',')}`;
    const cached = this.cache.get(cacheKey);
    if (cached && this.clock() < cached.expiresAt) return cached.entitlement;

    let entitlement: EffectiveEntitlement;
    try {
      entitlement = await this.fetchFresh(userId, actorType, featureKey, metricKeys, now);
    } catch {
      // Fail-open: last known value if we have one, else an unlimited
      // fallback that never blocks legacy/observe. enforce mode treats
      // source='fallback_error' as "policy unavailable" and fails closed —
      // see enforcement.ts.
      if (cached) return cached.entitlement;
      entitlement = {
        allowed: true,
        userId,
        actorType,
        featureKey,
        effectivePlanId: null,
        limits: metricKeys.map((metricKey) => ({ metricKey, limit: null, period: 'none', periodStart: null, resetAt: null })),
        source: 'fallback_error',
        revision: null,
        resolvedAt: now.toISOString(),
      };
    }

    this.cache.set(cacheKey, { entitlement, expiresAt: this.clock() + this.ttlMs });
    return entitlement;
  }

  private async fetchFresh(
    userId: string,
    actorType: ActorType,
    featureKey: AiFeatureKey,
    metricKeys: string[],
    now: Date,
  ): Promise<EffectiveEntitlement> {
    const { data: planRows, error: planErr } = await this.supabase.rpc('admin_resolve_effective_plan_v1', {
      p_user_id: userId,
      p_at: now.toISOString(),
    });
    if (planErr) throw new Error(`admin_resolve_effective_plan_v1 failed: ${planErr.message}`);

    const plan = (Array.isArray(planRows) ? planRows[0] : planRows) as EffectivePlanRow | undefined;
    if (!plan) {
      return {
        allowed: true, userId, actorType, featureKey, effectivePlanId: null,
        limits: metricKeys.map((metricKey) => ({ metricKey, limit: null, period: 'none', periodStart: null, resetAt: null })),
        source: 'no_plan_configured', revision: null, resolvedAt: now.toISOString(),
      };
    }

    if (!plan.access_allowed) {
      return {
        allowed: false, userId, actorType, featureKey, effectivePlanId: plan.plan_id,
        limits: [], source: 'plan', revision: plan.version_number, resolvedAt: now.toISOString(),
      };
    }

    const limits: EntitlementLimit[] = [];
    let sawPlanCapability = false;
    let sawOverride = false;
    // Lazily fetched at most once per resolve() call, only if some
    // capability's period actually resolves to 'assignment_cycle' — the
    // common case (day/week/month/lifetime/none) never touches this table.
    let assignmentWindow: { startsAt: string | null; endsAt: string | null } | null | undefined;
    const getAssignmentWindow = async (): Promise<{ startsAt: string | null; endsAt: string | null } | null> => {
      if (assignmentWindow !== undefined) return assignmentWindow;
      if (!plan.assignment_id) { assignmentWindow = null; return assignmentWindow; }
      const { data } = await this.supabase
        .from('user_plan_assignments')
        .select('starts_at, ends_at')
        .eq('id', plan.assignment_id)
        .maybeSingle();
      const row = data as { starts_at: string | null; ends_at: string | null } | null;
      assignmentWindow = row ? { startsAt: row.starts_at, endsAt: row.ends_at } : null;
      return assignmentWindow;
    };

    for (const metricKey of metricKeys) {
      const capabilityKey = capabilityKeyFor(featureKey, metricKey);
      let limit: number | null = null;
      let period: EntitlementLimit['period'] = 'none';

      if (capabilityKey && plan.plan_version_id) {
        const { data: capRow } = await this.supabase
          .from('plan_capability_values')
          .select('value, period')
          .eq('plan_version_id', plan.plan_version_id)
          .eq('capability_key', capabilityKey)
          .maybeSingle();
        if (capRow) {
          sawPlanCapability = true;
          limit = toNumericLimit((capRow as { value: unknown }).value);
          period = toPeriod((capRow as { period: unknown }).period);
        }
      }

      if (capabilityKey) {
        const { data: overrideRows } = await this.supabase
          .from('user_capability_overrides')
          .select('operation, value, period')
          .eq('user_id', userId)
          .eq('capability_key', capabilityKey)
          .eq('status', 'active')
          .lte('starts_at', now.toISOString())
          .or(`ends_at.is.null,ends_at.gt.${now.toISOString()}`)
          .order('created_at', { ascending: false })
          .limit(1);
        const override = overrideRows?.[0] as { operation: string; value: unknown; period: unknown } | undefined;
        if (override) {
          sawOverride = true;
          if (override.operation === 'unlimited') { limit = null; }
          else if (override.operation === 'disable') { limit = 0; }
          else if (override.operation === 'replace') { limit = toNumericLimit(override.value); period = toPeriod(override.period) ?? period; }
          else if (override.operation === 'add' && limit !== null) {
            const delta = toNumericLimit(override.value);
            if (delta !== null) limit = limit + delta;
          }
        }
      }

      const window = period === 'assignment_cycle' ? await getAssignmentWindow() : null;
      const { periodStart, resetAt } = periodBoundsFor(period, now, window);
      limits.push({ metricKey, limit, period, periodStart, resetAt });
    }

    return {
      allowed: true,
      userId,
      actorType,
      featureKey,
      effectivePlanId: plan.plan_id,
      limits,
      source: sawOverride ? 'override' : sawPlanCapability ? 'plan' : 'no_plan_configured',
      revision: plan.version_number,
      resolvedAt: now.toISOString(),
    };
  }

  invalidate(): void {
    this.cache.clear();
  }
}
