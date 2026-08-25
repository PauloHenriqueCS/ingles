import { describe, it, expect, vi, beforeEach } from 'vitest';

// Simulates a real iOS native build with the Purchases plugin registered —
// see runtimeEnvironment.ts's module-level isIOSApp/isPluginAvailable.
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'ios',
    isNativePlatform: () => true,
    isPluginAvailable: (name: string) => name === 'Purchases',
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

const PURCHASES_ERROR_CODE = {
  PURCHASE_CANCELLED_ERROR: 'PURCHASE_CANCELLED_ERROR',
  PRODUCT_ALREADY_PURCHASED_ERROR: 'PRODUCT_ALREADY_PURCHASED_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR',
};

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
  PURCHASES_ERROR_CODE,
}));

import {
  isRevenueCatSupported,
  isRevenueCatConfigured,
  subscribeReady,
  syncIdentity,
  getCustomerInfo,
  getOfferings,
  purchasePackage,
  restorePurchases,
  getManagementUrl,
  addCustomerInfoListener,
  __resetRevenueCatClientForTests,
} from './revenueCatClient';

const USER_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER_B = 'bbbbbbbb-0000-0000-0000-000000000002';

function customerInfo(overrides: { activeEntitlements?: Record<string, unknown>; managementURL?: string | null } = {}) {
  return {
    entitlements: { active: overrides.activeEntitlements ?? {} },
    managementURL: overrides.managementURL ?? null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetRevenueCatClientForTests();
  vi.stubEnv('VITE_REVENUECAT_APPLE_API_KEY', 'test-apple-key');
  mockConfigure.mockResolvedValue({ customerInfo: customerInfo() });
  mockLogIn.mockResolvedValue({ customerInfo: customerInfo(), created: false });
  mockLogOut.mockResolvedValue({ customerInfo: customerInfo() });
  mockGetCustomerInfo.mockResolvedValue({ customerInfo: customerInfo() });
});

describe('revenueCatClient on iOS — support detection', () => {
  it('isRevenueCatSupported() is true', () => {
    expect(isRevenueCatSupported()).toBe(true);
  });
});

describe('revenueCatClient on iOS — identity sync', () => {
  it('configures the SDK once with the Supabase UUID as appUserID (never an email)', async () => {
    await syncIdentity(USER_A);
    expect(mockConfigure).toHaveBeenCalledTimes(1);
    expect(mockConfigure).toHaveBeenCalledWith({ apiKey: 'test-apple-key', appUserID: USER_A });
    expect(mockLogIn).not.toHaveBeenCalled();
  });

  it('does not call configure() a second time for a redundant call with the same user', async () => {
    await syncIdentity(USER_A);
    await syncIdentity(USER_A);
    expect(mockConfigure).toHaveBeenCalledTimes(1);
    expect(mockLogIn).not.toHaveBeenCalled();
  });

  it('switches identity via logIn (not a second configure) when the user changes', async () => {
    await syncIdentity(USER_A);
    await syncIdentity(USER_B);
    expect(mockConfigure).toHaveBeenCalledTimes(1);
    expect(mockLogIn).toHaveBeenCalledTimes(1);
    expect(mockLogIn).toHaveBeenCalledWith({ appUserID: USER_B });
  });

  it('logs out when the session goes from identified to signed-out', async () => {
    await syncIdentity(USER_A);
    await syncIdentity(null);
    expect(mockLogOut).toHaveBeenCalledTimes(1);
  });

  it('never configures anonymously — a null userId before auth resolves is a pure no-op (no SDK call at all)', async () => {
    await syncIdentity(null);
    expect(mockConfigure).not.toHaveBeenCalled();
    expect(mockLogOut).not.toHaveBeenCalled();
    expect(isRevenueCatSupported()).toBe(true); // sanity: this isn't the web/unsupported no-op path
  });

  it('a null-first sync followed by the real Supabase UUID configures once, with the real UUID (never undefined/anonymous)', async () => {
    await syncIdentity(null); // e.g. useAuth() hasn't resolved a session yet on cold start
    await syncIdentity(USER_A); // auth resolves — App.tsx re-fires the effect with the real id
    expect(mockConfigure).toHaveBeenCalledTimes(1);
    expect(mockConfigure).toHaveBeenCalledWith({ apiKey: 'test-apple-key', appUserID: USER_A });
    expect(mockLogIn).not.toHaveBeenCalled();
  });

  it('repeated null syncs before auth resolves never configure, no matter how many times the effect re-fires', async () => {
    await syncIdentity(null);
    await syncIdentity(null);
    await syncIdentity(null);
    expect(mockConfigure).not.toHaveBeenCalled();
  });

  it('does not call logOut on a redundant null sync once already signed out post-configure', async () => {
    await syncIdentity(USER_A);
    await syncIdentity(null);
    mockLogOut.mockClear();
    await syncIdentity(null);
    expect(mockLogOut).not.toHaveBeenCalled();
  });

  it('never configures without an API key — purchases just stay unavailable, no crash', async () => {
    vi.stubEnv('VITE_REVENUECAT_APPLE_API_KEY', '');
    await expect(syncIdentity(USER_A)).resolves.toBeUndefined();
    expect(mockConfigure).not.toHaveBeenCalled();
  });

  it('overlapping syncIdentity calls are serialized, never racing (fast sign-out-then-sign-in)', async () => {
    const first = syncIdentity(USER_A);
    const second = syncIdentity(USER_B);
    await Promise.all([first, second]);
    expect(mockConfigure).toHaveBeenCalledTimes(1);
    expect(mockLogIn).toHaveBeenCalledTimes(1);
    expect(mockLogIn).toHaveBeenCalledWith({ appUserID: USER_B });
  });
});

describe('revenueCatClient on iOS — getCustomerInfo / listener', () => {
  it('resolves null before the SDK has been configured', async () => {
    await expect(getCustomerInfo()).resolves.toBeNull();
    expect(mockGetCustomerInfo).not.toHaveBeenCalled();
  });

  it('maps entitlements and managementURL once configured', async () => {
    await syncIdentity(USER_A);
    mockGetCustomerInfo.mockResolvedValue({
      customerInfo: customerInfo({ activeEntitlements: { plus: {} }, managementURL: 'https://apps.apple.com/account/subscriptions' }),
    });
    const info = await getCustomerInfo();
    expect(info).toEqual({
      activeEntitlementIds: ['plus'],
      activePlanCode: 'plus',
      managementUrl: 'https://apps.apple.com/account/subscriptions',
    });
  });

  it('registers the CustomerInfo listener at most once', async () => {
    const onUpdate = vi.fn();
    await addCustomerInfoListener(onUpdate);
    await addCustomerInfoListener(onUpdate);
    expect(mockAddCustomerInfoUpdateListener).toHaveBeenCalledTimes(1);
  });
});

describe('revenueCatClient on iOS — getManagementUrl (gates the manage-subscription UI)', () => {
  it('is null when the customer has no management URL — a screen must hide the button', async () => {
    await syncIdentity(USER_A);
    mockGetCustomerInfo.mockResolvedValue({ customerInfo: customerInfo({ managementURL: null }) });
    await expect(getManagementUrl()).resolves.toBeNull();
  });

  it('returns the real store URL when present', async () => {
    await syncIdentity(USER_A);
    mockGetCustomerInfo.mockResolvedValue({ customerInfo: customerInfo({ managementURL: 'https://apps.apple.com/account/subscriptions' }) });
    await expect(getManagementUrl()).resolves.toBe('https://apps.apple.com/account/subscriptions');
  });
});

describe('revenueCatClient on iOS — getOfferings', () => {
  it('returns an empty list when there is no current offering', async () => {
    await syncIdentity(USER_A);
    mockGetOfferings.mockResolvedValue({ current: null });
    await expect(getOfferings()).resolves.toEqual([]);
  });

  it('maps packages by package id, keeping the (bare, on iOS) store product id', async () => {
    await syncIdentity(USER_A);
    mockGetOfferings.mockResolvedValue({
      current: {
        availablePackages: [
          {
            identifier: 'essential_monthly',
            product: {
              identifier: 'orodim.subscription.essential.monthly',
              title: 'Essencial',
              description: '30 minutos de conversação por mês',
              priceString: 'R$ 34,90',
              subscriptionPeriod: 'P1M',
            },
          },
        ],
      },
    });
    const offerings = await getOfferings();
    expect(offerings).toEqual([
      {
        packageId: 'essential_monthly',
        productId: 'orodim.subscription.essential.monthly',
        title: 'Essencial',
        description: '30 minutos de conversação por mês',
        priceFormatted: 'R$ 34,90',
        subscriptionPeriod: 'P1M',
      },
    ]);
  });
});

describe('revenueCatClient on iOS — purchasePackage', () => {
  const PACKAGE_ID = 'essential_monthly';

  async function loadOneOffering() {
    mockGetOfferings.mockResolvedValue({
      current: {
        availablePackages: [{ identifier: PACKAGE_ID, product: { identifier: 'orodim.subscription.essential.monthly', title: 'Essencial', description: '', priceString: 'R$ 34,90' } }],
      },
    });
    await getOfferings();
  }

  it('a genuinely absent package returns product_not_found after exactly one refresh (no retry loop, no purchase)', async () => {
    await syncIdentity(USER_A);
    mockGetOfferings.mockResolvedValue({ current: null }); // nothing to load, even after refresh
    const result = await purchasePackage(PACKAGE_ID);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('product_not_found');
    expect(mockGetOfferings).toHaveBeenCalledTimes(1); // single safe refresh, never a loop
    expect(mockPurchasePackage).not.toHaveBeenCalled();
  });

  it('an empty cache triggers ONE offerings refresh that finds the package, then completes the purchase', async () => {
    await syncIdentity(USER_A);
    mockGetOfferings.mockResolvedValue({
      current: { availablePackages: [{ identifier: PACKAGE_ID, product: { identifier: 'orodim.subscription.essential.monthly', title: 'Essencial', description: '', priceString: 'R$ 34,90' } }] },
    });
    mockPurchasePackage.mockResolvedValue({ customerInfo: customerInfo({ activeEntitlements: { essential: {} } }) });
    const result = await purchasePackage(PACKAGE_ID);
    expect(mockGetOfferings).toHaveBeenCalledTimes(1); // single refresh
    expect(mockPurchasePackage).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.customerInfo?.activePlanCode).toBe('essencial');
  });

  it('a package already in cache purchases without any extra refresh', async () => {
    await syncIdentity(USER_A);
    await loadOneOffering();
    mockGetOfferings.mockClear();
    mockPurchasePackage.mockResolvedValue({ customerInfo: customerInfo({ activeEntitlements: { essential: {} } }) });
    const result = await purchasePackage(PACKAGE_ID);
    expect(mockGetOfferings).not.toHaveBeenCalled(); // no wasted refresh on a cache hit
    expect(result.ok).toBe(true);
  });

  it('a completed purchase returns ok:true with the mapped customerInfo', async () => {
    await syncIdentity(USER_A);
    await loadOneOffering();
    mockPurchasePackage.mockResolvedValue({ customerInfo: customerInfo({ activeEntitlements: { essential: {} } }) });
    const result = await purchasePackage(PACKAGE_ID);
    expect(result).toEqual({
      ok: true,
      customerInfo: { activeEntitlementIds: ['essential'], activePlanCode: 'essencial', managementUrl: null },
      error: null,
    });
  });

  it('a cancelled purchase (userCancelled flag) maps to user_cancelled, never a raw SDK error', async () => {
    await syncIdentity(USER_A);
    await loadOneOffering();
    mockPurchasePackage.mockRejectedValue({ userCancelled: true, message: 'cancelled' });
    const result = await purchasePackage(PACKAGE_ID);
    expect(result.ok).toBe(false);
    expect(result.error).toEqual({ code: 'user_cancelled', message: 'Compra cancelada.' });
  });

  it('a cancelled purchase (error code form) also maps to user_cancelled', async () => {
    await syncIdentity(USER_A);
    await loadOneOffering();
    mockPurchasePackage.mockRejectedValue({ code: 'PURCHASE_CANCELLED_ERROR' });
    const result = await purchasePackage(PACKAGE_ID);
    expect(result.error?.code).toBe('user_cancelled');
  });

  it('a generic/unexpected purchase error maps to unknown, never leaks the raw SDK error', async () => {
    await syncIdentity(USER_A);
    await loadOneOffering();
    mockPurchasePackage.mockRejectedValue({ code: 'SOME_OTHER_ERROR', message: 'boom' });
    const result = await purchasePackage(PACKAGE_ID);
    expect(result).toEqual({
      ok: false,
      customerInfo: null,
      error: { code: 'unknown', message: 'Não foi possível concluir a compra. Tente novamente.' },
    });
  });

  it('returns not_configured before the SDK has been configured', async () => {
    const result = await purchasePackage(PACKAGE_ID);
    expect(result.error?.code).toBe('not_configured');
    expect(mockPurchasePackage).not.toHaveBeenCalled();
  });
});

describe('revenueCatClient on iOS — plan change never sends store change info (App Store manages the group)', () => {
  it('a change (upgrade/downgrade) still only sends aPackage on iOS — storeProductChangeInfo is Android-only', async () => {
    await syncIdentity(USER_A);
    mockGetOfferings.mockResolvedValue({
      current: { availablePackages: [{ identifier: 'plus_monthly', product: { identifier: 'orodim.subscription.plus.monthly', title: 'Plus', description: '', priceString: 'R$ 59,90' } }] },
    });
    await getOfferings();
    mockPurchasePackage.mockResolvedValue({ customerInfo: customerInfo({ activeEntitlements: { plus: {} } }) });
    const result = await purchasePackage('plus_monthly', { oldProductId: 'orodim.subscription.essential.monthly', mode: 'upgrade' });
    expect(result.ok).toBe(true);
    const arg = mockPurchasePackage.mock.calls[0][0] as any;
    expect(arg.storeProductChangeInfo).toBeUndefined();
    expect(arg.aPackage).toBeDefined();
  });
});

describe('revenueCatClient on iOS — restorePurchases', () => {
  it('an explicit restore returns ok:true with the mapped customerInfo', async () => {
    await syncIdentity(USER_A);
    mockRestorePurchases.mockResolvedValue({ customerInfo: customerInfo({ activeEntitlements: { plus: {} } }) });
    const result = await restorePurchases();
    expect(result.ok).toBe(true);
    expect(result.customerInfo?.activePlanCode).toBe('plus');
  });

  it('finding nothing to restore still resolves ok:true with no active entitlements (caller decides the "none found" copy)', async () => {
    await syncIdentity(USER_A);
    mockRestorePurchases.mockResolvedValue({ customerInfo: customerInfo() });
    const result = await restorePurchases();
    expect(result.ok).toBe(true);
    expect(result.customerInfo?.activeEntitlementIds).toEqual([]);
  });

  it('a network failure during restore maps to network_error', async () => {
    await syncIdentity(USER_A);
    mockRestorePurchases.mockRejectedValue({ code: 'NETWORK_ERROR' });
    const result = await restorePurchases();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('network_error');
  });

  it('returns not_configured before the SDK has been configured', async () => {
    const result = await restorePurchases();
    expect(result.error?.code).toBe('not_configured');
    expect(mockRestorePurchases).not.toHaveBeenCalled();
  });
});

describe('revenueCatClient on iOS — readiness / offerings race', () => {
  const OFFERING = {
    current: {
      availablePackages: [{ identifier: 'essential_monthly', product: { identifier: 'orodim.subscription.essential.monthly', title: 'Essencial', description: '', priceString: 'R$ 34,90' } }],
    },
  };

  it('getOfferings() called while configure() is still in flight waits for it, then returns the real list', async () => {
    let resolveConfigure!: () => void;
    mockConfigure.mockReturnValue(new Promise<void>((resolve) => { resolveConfigure = () => resolve(); }));
    mockGetOfferings.mockResolvedValue(OFFERING);

    const sync = syncIdentity(USER_A);
    const offeringsPromise = getOfferings();

    resolveConfigure();
    await sync;
    const offerings = await offeringsPromise;
    expect(offerings.map((o) => o.packageId)).toEqual(['essential_monthly']);
  });

  it('a pre-configure load gets an empty list, and the readiness subscriber then fires so the screen can reload', async () => {
    const onReady = vi.fn();
    subscribeReady(onReady);
    mockGetOfferings.mockResolvedValue({ current: null });
    expect(await getOfferings()).toEqual([]);
    expect(onReady).not.toHaveBeenCalled();
    await syncIdentity(USER_A);
    expect(onReady).toHaveBeenCalledTimes(1);
    mockGetOfferings.mockResolvedValue(OFFERING);
    expect((await getOfferings()).map((o) => o.packageId)).toEqual(['essential_monthly']);
  });

  it('switching users notifies readiness again (offerings are per-identity)', async () => {
    await syncIdentity(USER_A);
    const onReady = vi.fn();
    subscribeReady(onReady);
    await syncIdentity(USER_B);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('logout then login keeps the SDK configured and fires readiness on each transition', async () => {
    await syncIdentity(USER_A);
    const onReady = vi.fn();
    subscribeReady(onReady);
    await syncIdentity(null);
    await syncIdentity(USER_B);
    expect(onReady).toHaveBeenCalledTimes(2);
    expect(isRevenueCatConfigured()).toBe(true);
  });

  it('isRevenueCatConfigured() reflects configure state', async () => {
    expect(isRevenueCatConfigured()).toBe(false);
    await syncIdentity(USER_A);
    expect(isRevenueCatConfigured()).toBe(true);
  });
});
