import { describe, it, expect, vi, beforeEach } from 'vitest';

// Simulates the real web build: Capacitor.getPlatform() is 'web' and
// isNativePlatform() is false, exactly like running in a browser tab with no
// native shell — see runtimeEnvironment.ts's module-level isIOSApp.
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'web',
    isNativePlatform: () => false,
    isPluginAvailable: () => false,
  },
}));

const mockConfigure = vi.fn();
const mockLogIn = vi.fn();
const mockLogOut = vi.fn();
const mockGetCustomerInfo = vi.fn();
const mockGetOfferings = vi.fn();
const mockPurchasePackage = vi.fn();
const mockRestorePurchases = vi.fn();
const mockAddCustomerInfoUpdateListener = vi.fn();

vi.mock('@revenuecat/purchases-capacitor', () => ({
  Purchases: {
    configure: mockConfigure,
    logIn: mockLogIn,
    logOut: mockLogOut,
    getCustomerInfo: mockGetCustomerInfo,
    getOfferings: mockGetOfferings,
    purchasePackage: mockPurchasePackage,
    restorePurchases: mockRestorePurchases,
    addCustomerInfoUpdateListener: mockAddCustomerInfoUpdateListener,
  },
  PURCHASES_ERROR_CODE: {},
}));

import {
  isRevenueCatSupported,
  syncIdentity,
  getCustomerInfo,
  getOfferings,
  purchasePackage,
  restorePurchases,
  getManagementUrl,
  addCustomerInfoListener,
  __resetRevenueCatClientForTests,
} from './revenueCatClient';

beforeEach(() => {
  vi.clearAllMocks();
  __resetRevenueCatClientForTests();
  vi.stubEnv('VITE_REVENUECAT_APPLE_API_KEY', 'test-apple-key');
});

describe('revenueCatClient on the web build', () => {
  it('isRevenueCatSupported() is false', () => {
    expect(isRevenueCatSupported()).toBe(false);
  });

  it('syncIdentity never touches the SDK (no checkout on the website)', async () => {
    await syncIdentity('aaaaaaaa-0000-0000-0000-000000000001');
    expect(mockConfigure).not.toHaveBeenCalled();
    expect(mockLogIn).not.toHaveBeenCalled();
  });

  it('getCustomerInfo resolves to null without importing the SDK', async () => {
    await expect(getCustomerInfo()).resolves.toBeNull();
    expect(mockGetCustomerInfo).not.toHaveBeenCalled();
  });

  it('getOfferings resolves to an empty list', async () => {
    await expect(getOfferings()).resolves.toEqual([]);
    expect(mockGetOfferings).not.toHaveBeenCalled();
  });

  it('purchasePackage returns a not_configured error, never calls the SDK', async () => {
    const result = await purchasePackage('essential_monthly');
    expect(result).toEqual({ ok: false, customerInfo: null, error: { code: 'not_configured', message: 'Compras não estão disponíveis.' } });
    expect(mockPurchasePackage).not.toHaveBeenCalled();
  });

  it('restorePurchases returns a not_configured error, never calls the SDK', async () => {
    const result = await restorePurchases();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('not_configured');
    expect(mockRestorePurchases).not.toHaveBeenCalled();
  });

  it('getManagementUrl resolves to null', async () => {
    await expect(getManagementUrl()).resolves.toBeNull();
  });

  it('addCustomerInfoListener never registers a listener', async () => {
    await addCustomerInfoListener(() => {});
    expect(mockAddCustomerInfoUpdateListener).not.toHaveBeenCalled();
  });
});
