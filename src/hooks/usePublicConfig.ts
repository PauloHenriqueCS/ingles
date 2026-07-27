import { useEffect, useState } from 'react';
import type { ProductConfigValues } from '../server/product-config/types';

// Type-only import — types.ts has zero runtime dependencies (no
// supabase-js, no env reads), safe to reference from client bundles.
export type PublicConfigValues = Pick<
  ProductConfigValues,
  | 'signup.registration'
  | 'maintenance.mode'
  | 'features.writing'
  | 'features.conversation'
  | 'features.pronunciation'
  | 'features.listening'
  | 'features.calendar'
  | 'features.evolution'
  | 'features.memory'
  | 'product.timezone'
>;

interface PublicConfigResponse {
  environment: string;
  values: PublicConfigValues;
  usingFallback: boolean;
}

// Module-level cache: one fetch per page load, shared by every component
// that mounts the hook — GET /api/config/public already sets its own
// short Cache-Control, this just avoids firing it once per component.
let cached: PublicConfigResponse | null = null;
let inflight: Promise<PublicConfigResponse> | null = null;

function fetchPublicConfig(): Promise<PublicConfigResponse> {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = fetch('/api/config/public')
    .then((r) => {
      if (!r.ok) throw new Error(`config fetch failed: ${r.status}`);
      return r.json() as Promise<PublicConfigResponse>;
    })
    .then((data) => {
      cached = data;
      return data;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export interface PublicConfigState {
  config: PublicConfigValues | null;
  loading: boolean;
}

// A failed fetch leaves config === null — callers must treat that as "no
// restriction known" (render normally), never as "blocked". The real
// enforcement is server-side regardless; this is presentation only.
export function usePublicConfig(): PublicConfigState {
  const [config, setConfig] = useState<PublicConfigValues | null>(cached?.values ?? null);
  const [loading, setLoading] = useState(!cached);

  useEffect(() => {
    if (cached) {
      setConfig(cached.values);
      setLoading(false);
      return;
    }
    let cancelled = false;
    fetchPublicConfig()
      .then((data) => {
        if (!cancelled) setConfig(data.values);
      })
      .catch(() => {
        // keep config null — see PublicConfigState doc above
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { config, loading };
}
