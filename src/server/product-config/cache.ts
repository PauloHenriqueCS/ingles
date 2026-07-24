// SERVER-ONLY: short-TTL in-memory cache, same shape as
// api/_ai-gateway/policy-resolver.ts's GatewayPolicyResolver cache
// (clock injectable for tests).

import type { ResolvedProductConfig } from './types';

export const SUCCESS_TTL_MS = 30_000;
export const FALLBACK_TTL_MS = 5_000;

interface CacheEntry {
  config: ResolvedProductConfig;
  expiresAt: number;
}

export class ProductConfigCache {
  private readonly clock: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  get(environment: string): ResolvedProductConfig | null {
    const entry = this.cache.get(environment);
    if (entry && this.clock() < entry.expiresAt) return entry.config;
    return null;
  }

  set(environment: string, config: ResolvedProductConfig): void {
    const ttl = config.usingFallback ? FALLBACK_TTL_MS : SUCCESS_TTL_MS;
    this.cache.set(environment, { config, expiresAt: this.clock() + ttl });
  }

  invalidate(): void {
    this.cache.clear();
  }
}
