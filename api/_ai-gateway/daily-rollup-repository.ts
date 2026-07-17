/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 *
 * Thin wrapper around the atomic Postgres RPCs that rebuild usage_daily /
 * usage_daily_metrics from raw ai_usage_events / ai_usage_event_metrics.
 * All atomicity, full-recompute, and concurrency-safety (advisory lock)
 * live in the SQL functions themselves (see migration
 * 20260717110000_ai_gateway_daily_rollup.sql) — this class only shapes the
 * RPC calls and their results.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSharedServiceClient } from './usage-repository';

export interface DailyBucketDimensions {
  usageDate: string; // 'YYYY-MM-DD', UTC day
  userId: string | null;
  actorType: string;
  featureKey: string;
  provider: string;
  model: string | null;
}

export interface DailyBucketKey extends DailyBucketDimensions {
  bucketKey: string;
}

export interface DailyRollupRepositoryInterface {
  /** Resolves the bucket from the event itself; returns null if the event does not exist. */
  rebuildBucketForEvent(eventId: string): Promise<string | null>;
  /** Rebuilds a bucket identified explicitly by its dimensions. */
  rebuildBucket(dimensions: DailyBucketDimensions): Promise<string>;
  /** Paginated list of distinct bucket keys present for a UTC date — never raw events. */
  listBucketsForDate(usageDate: string, limit: number, afterKey: string | null): Promise<DailyBucketKey[]>;
}

export class SupabaseDailyRollupRepository implements DailyRollupRepositoryInterface {
  private readonly supabase: SupabaseClient;

  constructor(supabase?: SupabaseClient) {
    this.supabase = supabase ?? getSharedServiceClient();
  }

  async rebuildBucketForEvent(eventId: string): Promise<string | null> {
    const { data, error } = await this.supabase.rpc('rebuild_usage_daily_bucket_for_event', {
      p_event_id: eventId,
    });
    if (error) {
      // "event not found" is a legitimate, expected outcome (e.g. a stale
      // id) — surface as null rather than throwing on every not-found case.
      if (error.message?.includes('not found')) return null;
      throw new Error(`rebuildBucketForEvent failed: ${error.message}`);
    }
    return (data as string) ?? null;
  }

  async rebuildBucket(d: DailyBucketDimensions): Promise<string> {
    const { data, error } = await this.supabase.rpc('rebuild_usage_daily_bucket', {
      p_usage_date:  d.usageDate,
      p_user_id:     d.userId,
      p_actor_type:  d.actorType,
      p_feature_key: d.featureKey,
      p_provider:    d.provider,
      p_model:       d.model,
    });
    if (error || !data) throw new Error(`rebuildBucket failed: ${error?.message ?? 'no data'}`);
    return data as string;
  }

  async listBucketsForDate(usageDate: string, limit: number, afterKey: string | null): Promise<DailyBucketKey[]> {
    const { data, error } = await this.supabase.rpc('list_usage_daily_buckets_for_date', {
      p_usage_date: usageDate,
      p_limit:      limit,
      p_after_key:  afterKey,
    });
    if (error || !data) return [];
    return (data as Array<{
      bucket_key: string; user_id: string | null; actor_type: string;
      feature_key: string; provider: string; model: string | null;
    }>).map((r) => ({
      bucketKey:  r.bucket_key,
      usageDate,
      userId:     r.user_id,
      actorType:  r.actor_type,
      featureKey: r.feature_key,
      provider:   r.provider,
      model:      r.model,
    }));
  }
}
