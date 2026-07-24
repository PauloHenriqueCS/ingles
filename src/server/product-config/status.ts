// SERVER-ONLY: builds the payload for GET /api/internal/product-config/status.
// Never includes config values (public or server-only) — metadata only.

import { safeLog } from '../../../api/_helpers';
import { fetchPublishedVersionMeta, getProductConfigServiceClient } from './client';
import { resolveConfigEnvironment } from './environment';
import { getDefaultProductConfigService, type ProductConfigService } from './service';
import type { ConfigEnvironment, ConfigSource } from './types';

export interface ProductConfigStatusPayload {
  integrationConnected: boolean;
  environment: ConfigEnvironment;
  publishedVersion: number | null;
  publishedRevision: number | null;
  loadedVersion: number;
  loadedRevision: number | null;
  loadedAt: string;
  usingFallback: boolean;
  schemaValid: boolean;
  source: ConfigSource;
  applicationVersion: string;
  syncValid: boolean;
  error?: string;
}

export async function buildStatusPayload(
  service: ProductConfigService = getDefaultProductConfigService(),
): Promise<ProductConfigStatusPayload> {
  const environment = resolveConfigEnvironment();
  const loaded = await service.getConfig(environment);

  let publishedVersion: number | null = null;
  let publishedRevision: number | null = null;
  let integrationConnected = true;
  let freshError: string | undefined;

  try {
    const client = getProductConfigServiceClient();
    const meta = await fetchPublishedVersionMeta(client, environment);
    publishedVersion = meta?.versionNumber ?? 0;
    publishedRevision = meta?.revision ?? null;
  } catch (err) {
    integrationConnected = false;
    freshError = err instanceof Error ? err.message : 'unknown error';
    safeLog('product-config/status', 'status_read_error', 500, { environment, error: freshError });
  }

  const inSync = integrationConnected && !loaded.usingFallback && publishedVersion === loaded.versionNumber;
  // The snapshot RPC never returns `revision` (only version_number/config_hash),
  // so we can only report it when we've independently confirmed the loaded
  // version IS the currently-published one — otherwise it's honestly unknown.
  const loadedRevision = inSync ? publishedRevision : null;

  const error = freshError ?? loaded.error;

  return {
    integrationConnected,
    environment,
    publishedVersion,
    publishedRevision,
    loadedVersion: loaded.versionNumber,
    loadedRevision,
    loadedAt: new Date(loaded.loadedAt).toISOString(),
    usingFallback: loaded.usingFallback,
    schemaValid: loaded.schemaValid,
    source: loaded.source,
    applicationVersion: process.env.VERCEL_GIT_COMMIT_SHA ?? 'unknown',
    syncValid: inSync,
    ...(error ? { error: error.slice(0, 500) } : {}),
  };
}
