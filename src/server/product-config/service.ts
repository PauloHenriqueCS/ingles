// SERVER-ONLY: single entry point for reading the published product config.
// Never fetches drafts — app_get_server_config_snapshot_v1 only ever returns
// the 'published' version for the given environment (enforced in SQL, not
// here). Falls back to SAFE_DEFAULTS on any read error, missing version, or
// schema mismatch, and never throws — callers always get a usable config.

import type { SupabaseClient } from '@supabase/supabase-js';
import { safeLog } from '../../../api/_helpers';
import { ackConfigSnapshot, fetchServerConfigSnapshot, getProductConfigServiceClient, type RawConfigSnapshot } from './client';
import { ProductConfigCache } from './cache';
import { SAFE_DEFAULTS } from './defaults';
import type { ConfigEnvironment, ResolvedProductConfig } from './types';
import { validateConfigValues } from './validators';

function buildFallback(
  environment: ConfigEnvironment,
  source: Extract<ResolvedProductConfig['source'], 'fallback_no_version' | 'fallback_error' | 'fallback_invalid_schema'>,
  loadedAt: number,
  error?: string,
): ResolvedProductConfig {
  return {
    environment,
    values: SAFE_DEFAULTS,
    versionNumber: 0,
    configHash: '',
    usingFallback: true,
    schemaValid: source !== 'fallback_invalid_schema',
    source,
    loadedAt,
    ...(error ? { error } : {}),
  };
}

export interface ProductConfigServiceOptions {
  client?: SupabaseClient;
  cache?: ProductConfigCache;
  clock?: () => number;
  instanceId?: string;
  appVersion?: string;
}

export class ProductConfigService {
  private readonly client: SupabaseClient;
  private readonly cache: ProductConfigCache;
  private readonly clock: () => number;
  private readonly instanceId: string;
  private readonly appVersion: string;

  constructor(options: ProductConfigServiceOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.client = options.client ?? getProductConfigServiceClient();
    this.cache = options.cache ?? new ProductConfigCache(this.clock);
    this.instanceId = options.instanceId ?? process.env.VERCEL_DEPLOYMENT_ID ?? 'local';
    this.appVersion = options.appVersion ?? process.env.VERCEL_GIT_COMMIT_SHA ?? 'unknown';
  }

  async getConfig(environment: ConfigEnvironment): Promise<ResolvedProductConfig> {
    const cached = this.cache.get(environment);
    if (cached) return cached;

    const resolved = await this.fetchAndValidate(environment);
    this.cache.set(environment, resolved);
    return resolved;
  }

  invalidate(): void {
    this.cache.invalidate();
  }

  private async fetchAndValidate(environment: ConfigEnvironment): Promise<ResolvedProductConfig> {
    const loadedAt = this.clock();
    let snapshot: RawConfigSnapshot;
    try {
      snapshot = await fetchServerConfigSnapshot(this.client, environment);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      safeLog('product-config/service', 'config_read_error', 500, { environment, error: message });
      // DB unreachable — skip the ack attempt too, it would just fail the same way.
      return buildFallback(environment, 'fallback_error', loadedAt, message);
    }

    if (!snapshot || snapshot.version_number === 0) {
      safeLog('product-config/service', 'config_not_found', 200, { environment });
      const fallback = buildFallback(environment, 'fallback_no_version', loadedAt);
      void this.ack(environment, fallback, snapshot);
      return fallback;
    }

    const validation = validateConfigValues(snapshot.values ?? {});
    if (!validation.valid) {
      safeLog('product-config/service', 'config_schema_invalid', 200, {
        environment,
        failingKeys: validation.failingKeys.join(','),
      });
      const fallback = buildFallback(
        environment,
        'fallback_invalid_schema',
        loadedAt,
        `invalid config keys: ${validation.failingKeys.join(', ')}`,
      );
      void this.ack(environment, fallback, snapshot);
      return fallback;
    }

    const resolved: ResolvedProductConfig = {
      environment,
      values: validation.values,
      versionNumber: snapshot.version_number,
      configHash: snapshot.config_hash,
      usingFallback: false,
      schemaValid: true,
      source: 'db',
      loadedAt,
    };
    safeLog('product-config/service', 'config_loaded', 200, {
      environment,
      versionNumber: resolved.versionNumber,
      configHash: resolved.configHash,
    });
    void this.ack(environment, resolved, snapshot);
    return resolved;
  }

  // Fire-and-forget: never lets an ack failure affect the resolved config.
  private async ack(environment: ConfigEnvironment, resolved: ResolvedProductConfig, snapshot: RawConfigSnapshot | null): Promise<void> {
    try {
      const result = !resolved.usingFallback ? 'applied' : resolved.source === 'fallback_invalid_schema' ? 'failed' : 'skipped';
      await ackConfigSnapshot(this.client, {
        environment,
        application: 'backend',
        instanceId: this.instanceId,
        versionReceived: snapshot?.version_number ?? 0,
        hashReceived: snapshot?.config_hash ?? '',
        versionApplied: resolved.usingFallback ? null : resolved.versionNumber,
        hashApplied: resolved.usingFallback ? null : resolved.configHash,
        appVersion: this.appVersion,
        result,
        errorSanitized: resolved.error ? resolved.error.slice(0, 1000) : null,
      });
    } catch {
      // best-effort only
    }
  }
}

let _defaultService: ProductConfigService | null = null;

export function getDefaultProductConfigService(): ProductConfigService {
  if (!_defaultService) _defaultService = new ProductConfigService();
  return _defaultService;
}
