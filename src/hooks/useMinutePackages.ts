import { useCallback, useEffect, useRef, useState } from 'react';
import { getAuthHeader } from '../lib/apiAuth';

/**
 * Real data source for the "Minutos adicionais" screen — fetches
 * GET /api/conversation/minute-packages (see api/conversation/[...slug].ts's
 * handleMinutePackages). The server owns eligibility (trial blocked,
 * conversation.extra_purchase_enabled), the catalog, and the BALANCE — the
 * screen never invents numbers.
 */

export interface MinutePackageDisplay {
  id: string;
  code: string;
  name: string;
  description: string | null;
  minutes: number;
  priceCents: number;
  currency: string;
  appleProductId: string | null;
  googleProductId: string | null;
}

export interface MinuteBalance {
  /** Internal/unlimited plans — no numeric balance, no purchase. */
  unlimited: boolean;
  monthlyLimitSeconds: number;
  monthlyConsumedSeconds: number;
  /** null when unlimited. */
  planIncludedRemainingSeconds: number | null;
  extraRemainingSeconds: number;
  /** null when unlimited. */
  totalRemainingSeconds: number | null;
  period: 'month' | 'lifetime' | 'day';
}

export interface MinutePackagesData {
  purchaseAvailable: boolean;
  packages: MinutePackageDisplay[];
  balance: MinuteBalance;
}

export interface UseMinutePackagesResult {
  data: MinutePackagesData | null;
  loading: boolean;
  error: boolean;
  /** Resolves to the fresh data (or null on error) so a caller can confirm a
   *  post-purchase credit landed without waiting for the next render. */
  refetch: () => Promise<MinutePackagesData | null>;
}

export function useMinutePackages(): UseMinutePackagesResult {
  const [data, setData] = useState<MinutePackagesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const refetch = useCallback(async (): Promise<MinutePackagesData | null> => {
    try {
      const headers = await getAuthHeader();
      const res = await fetch('/api/conversation/minute-packages', { headers });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const json = (await res.json()) as MinutePackagesData;
      if (mountedRef.current) {
        setData(json);
        setError(false);
      }
      return json;
    } catch {
      if (mountedRef.current) setError(true);
      return null;
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { data, loading, error, refetch };
}
