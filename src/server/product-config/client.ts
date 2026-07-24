// SERVER-ONLY: Supabase client + thin RPC wrappers for the dashboard's
// product-config RPCs. EXECUTE on these RPCs is granted only to
// postgres/service_role (confirmed live) — this module must never be
// imported from client-side code.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServiceCredentials } from '../../../api/_env';
import type { ConfigEnvironment } from './types';

let _client: SupabaseClient | null = null;

export function getProductConfigServiceClient(): SupabaseClient {
  if (_client) return _client;
  const { url, key } = getSupabaseServiceCredentials();
  if (!url || !key) {
    throw new Error('Missing Supabase service role credentials');
  }
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

export interface RawConfigSnapshot {
  environment: string;
  version_number: number;
  config_hash: string;
  etag: string;
  effective_from: string | null;
  values: Record<string, unknown>;
}

export async function fetchServerConfigSnapshot(
  client: SupabaseClient,
  environment: ConfigEnvironment,
): Promise<RawConfigSnapshot> {
  const { data, error } = await client.rpc('app_get_server_config_snapshot_v1', { p_environment: environment });
  if (error) throw new Error(`app_get_server_config_snapshot_v1 failed: ${error.message}`);
  return data as RawConfigSnapshot;
}

export interface PublishedVersionMeta {
  versionNumber: number;
  revision: number;
  configHash: string;
  publishedAt: string | null;
}

// Read-only: used only by the status endpoint (not the hot request path) to
// report the true current published state, bypassing this module's cache.
export async function fetchPublishedVersionMeta(
  client: SupabaseClient,
  environment: ConfigEnvironment,
): Promise<PublishedVersionMeta | null> {
  const { data, error } = await client.rpc('admin_get_product_config_versions_v1', { p_environment: environment });
  if (error) throw new Error(`admin_get_product_config_versions_v1 failed: ${error.message}`);
  const rows = (data ?? []) as Array<{
    state: string; version_number: number; revision: number; config_hash: string; published_at: string | null;
  }>;
  const published = rows.find((r) => r.state === 'published');
  if (!published) return null;
  return {
    versionNumber: published.version_number,
    revision: published.revision,
    configHash: published.config_hash,
    publishedAt: published.published_at,
  };
}

export interface AckSnapshotParams {
  environment: ConfigEnvironment;
  application: 'web' | 'backend' | 'mobile_ios' | 'mobile_android';
  instanceId: string;
  versionReceived: number;
  hashReceived: string;
  versionApplied: number | null;
  hashApplied: string | null;
  appVersion: string;
  result: 'applied' | 'failed' | 'skipped' | 'partial';
  errorSanitized?: string | null;
}

// Fire-and-forget from the caller's perspective — never throws, only logs.
export async function ackConfigSnapshot(client: SupabaseClient, params: AckSnapshotParams): Promise<{ ok: boolean; error?: string }> {
  const { error } = await client.rpc('app_ack_config_snapshot_v1', {
    p_environment: params.environment,
    p_application: params.application,
    p_instance_id: params.instanceId,
    p_version_received: params.versionReceived,
    p_hash_received: params.hashReceived,
    p_version_applied: params.versionApplied,
    p_hash_applied: params.hashApplied,
    p_app_version: params.appVersion,
    p_result: params.result,
    p_error_sanitized: params.errorSanitized ?? null,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
