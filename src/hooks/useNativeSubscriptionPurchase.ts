import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isRevenueCatSupported,
  isRevenueCatConfigured,
  subscribeReady,
  getOfferings,
  getCustomerInfo,
  addCustomerInfoListener,
  purchasePackage,
  restorePurchases,
} from '../lib/revenueCat/revenueCatClient';
import type { OrodimCustomerInfo, OrodimPlanChangeMode, OrodimProductOffering, OrodimPurchaseError } from '../lib/revenueCat/revenueCatTypes';

export interface NativeSubscriptionPurchaseState {
  /** false on web (and on Android/iOS without their store key configured)
   *  — the screen must never render store affordances then. */
  supported: boolean;
  offerings: OrodimProductOffering[];
  offeringsLoading: boolean;
  purchasing: string | null; // packageId currently being purchased, for a per-button loading state
  restoring: boolean;
  managementUrl: string | null;
  /** RevenueCat CustomerInfo.entitlements.active keys — the store's OWNERSHIP
   *  truth, fed to resolveSubscriptionUiState so a stale backend can never
   *  offer a plan the store already owns. Empty until loaded / on web. */
  activeEntitlementIds: string[];
  /** true once a getCustomerInfo() round-trip completed while the SDK was
   *  configured — OR immediately on web (nothing to load). Gates the
   *  reconciliation decision: an unconfigured empty read must not be mistaken
   *  for "owns nothing". */
  customerInfoLoaded: boolean;
  lastError: OrodimPurchaseError | null;
  /** Resolves true only on an actually-completed purchase, never on cancel/error.
   *  Takes a RevenueCat package identifier (see OrodimProductOffering.packageId). */
  purchase: (packageId: string) => Promise<boolean>;
  /** Upgrade/downgrade between commercial plans — replaces the current
   *  subscription instead of starting a parallel one. `targetPackageId` is the
   *  plan being switched TO; `currentProductId` is the store product id of the
   *  plan the user is on now (OrodimProductOffering.productId), needed by
   *  Android's replacement flow. Resolves true only on a completed change. */
  changePlan: (targetPackageId: string, currentProductId: string, mode: OrodimPlanChangeMode) => Promise<boolean>;
  restore: () => Promise<boolean>;
  refetchOfferings: () => void;
  /** Re-read offerings AND CustomerInfo from the store — call after a backend
   *  /sync so the store ownership shown reflects the reconciled state. */
  refreshStore: () => void;
}

/**
 * Native (iOS/Android) purchase affordances for the subscription screen.
 * Works identically on both stores — offerings/packages come from the
 * `default` offering and are matched by package id, so this hook needs no
 * platform branching (see revenueCatClient.ts's module doc comment).
 * Never the source of access truth (see subscription-status-service.ts) — a
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
  const [activeEntitlementIds, setActiveEntitlementIds] = useState<string[]>([]);
  // On web (unsupported) there is nothing to load — treat as loaded so the
  // screen resolves immediately from the backend alone.
  const [customerInfoLoaded, setCustomerInfoLoaded] = useState(!supported);
  const [lastError, setLastError] = useState<OrodimPurchaseError | null>(null);
  const [refetchToken, setRefetchToken] = useState(0);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Apply a fresh CustomerInfo (from a load, a purchase/restore result, or the
  // live listener) to the store-ownership + management-url state in one place.
  const applyCustomerInfo = useCallback((info: OrodimCustomerInfo | null) => {
    setActiveEntitlementIds(info?.activeEntitlementIds ?? []);
    setManagementUrl(info?.managementUrl ?? null);
  }, []);

  // Reload offerings whenever the RevenueCat SDK becomes ready or its identity
  // changes (configure/logIn/logOut completed). This is what closes the
  // mount-before-syncIdentity race: the first load below may run before the
  // SDK is configured and get an empty list, so we let the readiness signal
  // trigger a refetch instead of depending on the user tapping "atualizar".
  useEffect(() => {
    if (!supported) return;
    return subscribeReady(() => {
      if (mountedRef.current) setRefetchToken((t) => t + 1);
    });
  }, [supported]);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    setOfferingsLoading(true);
    // One CustomerInfo read serves both the store-ownership signal and the
    // management URL (getCustomerInfo already returns null pre-configure, so a
    // read that raced configure() just yields no ownership — the readiness
    // subscriber below re-runs this effect once the SDK is actually ready).
    Promise.all([getOfferings(), getCustomerInfo()])
      .then(([offeringsResult, info]) => {
        if (cancelled || !mountedRef.current) return;
        setOfferings(offeringsResult);
        applyCustomerInfo(info);
        // Only trust an empty ownership read once the SDK is actually
        // configured — otherwise leave customerInfoLoaded false and wait for
        // the readiness-triggered refetch.
        if (isRevenueCatConfigured()) setCustomerInfoLoaded(true);
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
  }, [supported, refetchToken, applyCustomerInfo]);

  // Keep store ownership fresh while the screen is open — a renewal, a
  // store-side change, or a purchase reflected from another surface all fire
  // this. Registered at most once (guarded in the client).
  useEffect(() => {
    if (!supported) return;
    let active = true;
    void addCustomerInfoListener((info) => {
      if (active && mountedRef.current) applyCustomerInfo(info);
    });
    return () => { active = false; };
  }, [supported, applyCustomerInfo]);

  // Shared purchase/change runner — same per-button loading + double-click
  // guard + error handling. A first purchase passes no `change`; an
  // upgrade/downgrade passes the replacement descriptor (Android replaces the
  // current subscription; iOS ignores it — see revenueCatClient.purchasePackage).
  const runPurchase = useCallback(async (
    packageId: string,
    change?: { oldProductId: string; mode: OrodimPlanChangeMode },
  ): Promise<boolean> => {
    if (!supported || purchasing) return false; // impedir duplo clique
    setPurchasing(packageId);
    setLastError(null);
    try {
      const result = await purchasePackage(packageId, change);
      if (!mountedRef.current) return false;
      if (!result.ok) {
        // user_cancelled is never surfaced as an alarming error — the
        // screen distinguishes it from real failures via error.code.
        setLastError(result.error);
        return false;
      }
      applyCustomerInfo(result.customerInfo);
      return true;
    } finally {
      if (mountedRef.current) setPurchasing(null);
    }
  }, [supported, purchasing, applyCustomerInfo]);

  const purchase = useCallback((packageId: string) => runPurchase(packageId), [runPurchase]);
  const changePlan = useCallback(
    (targetPackageId: string, currentProductId: string, mode: OrodimPlanChangeMode) =>
      runPurchase(targetPackageId, { oldProductId: currentProductId, mode }),
    [runPurchase],
  );

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
      applyCustomerInfo(result.customerInfo);
      return true;
    } finally {
      if (mountedRef.current) setRestoring(false);
    }
  }, [supported, restoring, applyCustomerInfo]);

  const refetchOfferings = useCallback(() => setRefetchToken((t) => t + 1), []);
  const refreshStore = refetchOfferings; // one token re-reads offerings + CustomerInfo

  return {
    supported,
    offerings,
    offeringsLoading,
    purchasing,
    restoring,
    managementUrl,
    activeEntitlementIds,
    customerInfoLoaded,
    lastError,
    purchase,
    changePlan,
    restore,
    refetchOfferings,
    refreshStore,
  };
}
