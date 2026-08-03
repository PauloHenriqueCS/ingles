import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isRevenueCatSupported,
  getOfferings,
  purchaseProduct,
  restorePurchases,
  getManagementUrl,
} from '../lib/revenueCat/revenueCatClient';
import type { OrodimProductOffering, OrodimPurchaseError } from '../lib/revenueCat/revenueCatTypes';

export interface NativeSubscriptionPurchaseState {
  /** false on web/Android — the screen must never render store affordances then. */
  supported: boolean;
  offerings: OrodimProductOffering[];
  offeringsLoading: boolean;
  purchasing: string | null; // productId currently being purchased, for a per-button loading state
  restoring: boolean;
  managementUrl: string | null;
  lastError: OrodimPurchaseError | null;
  /** Resolves true only on an actually-completed purchase, never on cancel/error. */
  purchase: (productId: string) => Promise<boolean>;
  restore: () => Promise<boolean>;
  refetchOfferings: () => void;
}

/**
 * Native-iOS-only purchase affordances for the subscription screen. Never
 * the source of access truth (see subscription-status-service.ts) — a
 * successful purchase/restore here only updates local UI optimistically;
 * SubscriptionView is responsible for triggering a backend resync
 * (POST /api/subscription/sync) afterwards so /api/subscription/status
 * reflects it for real.
 */
export function useNativeSubscriptionPurchase(): NativeSubscriptionPurchaseState {
  const supported = isRevenueCatSupported();
  const [offerings, setOfferings] = useState<OrodimProductOffering[]>([]);
  const [offeringsLoading, setOfferingsLoading] = useState(supported);
  const [purchasing, setPurchasing] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [managementUrl, setManagementUrl] = useState<string | null>(null);
  const [lastError, setLastError] = useState<OrodimPurchaseError | null>(null);
  const [refetchToken, setRefetchToken] = useState(0);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    setOfferingsLoading(true);
    Promise.all([getOfferings(), getManagementUrl()])
      .then(([offeringsResult, url]) => {
        if (cancelled || !mountedRef.current) return;
        setOfferings(offeringsResult);
        setManagementUrl(url);
      })
      .catch(() => {
        if (cancelled || !mountedRef.current) return;
        setOfferings([]);
      })
      .finally(() => {
        if (cancelled || !mountedRef.current) return;
        setOfferingsLoading(false);
      });
    return () => { cancelled = true; };
  }, [supported, refetchToken]);

  const purchase = useCallback(async (productId: string): Promise<boolean> => {
    if (!supported || purchasing) return false; // impedir duplo clique
    setPurchasing(productId);
    setLastError(null);
    try {
      const result = await purchaseProduct(productId);
      if (!mountedRef.current) return false;
      if (!result.ok) {
        // user_cancelled is never surfaced as an alarming error — the
        // screen distinguishes it from real failures via error.code.
        setLastError(result.error);
        return false;
      }
      setManagementUrl(result.customerInfo?.managementUrl ?? null);
      return true;
    } finally {
      if (mountedRef.current) setPurchasing(null);
    }
  }, [supported, purchasing]);

  const restore = useCallback(async (): Promise<boolean> => {
    if (!supported || restoring) return false;
    setRestoring(true);
    setLastError(null);
    try {
      const result = await restorePurchases();
      if (!mountedRef.current) return false;
      if (!result.ok) {
        setLastError(result.error);
        return false;
      }
      setManagementUrl(result.customerInfo?.managementUrl ?? null);
      return true;
    } finally {
      if (mountedRef.current) setRestoring(false);
    }
  }, [supported, restoring]);

  const refetchOfferings = useCallback(() => setRefetchToken((t) => t + 1), []);

  return { supported, offerings, offeringsLoading, purchasing, restoring, managementUrl, lastError, purchase, restore, refetchOfferings };
}
