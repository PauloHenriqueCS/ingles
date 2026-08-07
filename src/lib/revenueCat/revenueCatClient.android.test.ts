import { describe, it, expect, vi, beforeEach } from 'vitest';

// Simulates a real Android native build with the Purchases plugin
// registered — see runtimeEnvironment.ts's module-level
// isAndroidApp/isPluginAvailable.
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'android',
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
  syncIdentity,
  getCustomerInfo,
  getOfferings,
  purchaseProduct,
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
  vi.stubEnv('VITE_REVENUECAT_GOOGLE_API_KEY', 'test-google-key');
  mockConfigure.mockResolvedValue({ customerInfo: customerInfo() });
  mockLogIn.mockResolvedValue({ customerInfo: customerInfo(), created: false });
  mockLogOut.mockResolvedValue({ customerInfo: customerInfo() });
  mockGetCustomerInfo.mockResolvedValue({ customerInfo: customerInfo() });
});

describe('revenueCatClient on Android — support detection', () => {
  it('isRevenueCatSupported() is true', () => {
    expect(isRevenueCatSupported()).toBe(true);
  });
});

describe('revenueCatClient on Android — identity sync', () => {
  it('configures the SDK once with the Supabase UUID as appUserID (never an email)', async () => {
    await syncIdentity(USER_A);
    expect(mockConfigure).toHaveBeenCalledTimes(1);
    expect(mockConfigure).toHaveBeenCalledWith({ apiKey: 'test-google-key', appUserID: USER_A });
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
    expect(mockConfigure).toHaveBeenCalledWith({ apiKey: 'test-google-key', appUserID: USER_A });
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

  it('never configures without an API key — purchases just stay unavailable, no crash (the pre-Play-Console-connection state)', async () => {
    vi.stubEnv('VITE_REVENUECAT_GOOGLE_API_KEY', '');
    await expect(syncIdentity(USER_A)).resolves.toBeUndefined();
    expect(mockConfigure).not.toHaveBeenCalled();
  });

  it('never reads the Apple key on Android, even if it happens to be set', async () => {
    vi.stubEnv('VITE_REVENUECAT_APPLE_API_KEY', 'test-apple-key');
    vi.stubEnv('VITE_REVENUECAT_GOOGLE_API_KEY', '');
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

describe('revenueCatClient on Android — getCustomerInfo / listener', () => {
  it('resolves null before the SDK has been configured', async () => {
    await expect(getCustomerInfo()).resolves.toBeNull();
    expect(mockGetCustomerInfo).not.toHaveBeenCalled();
  });

  it('maps entitlements and managementURL once configured', async () => {
    await syncIdentity(USER_A);
    mockGetCustomerInfo.mockResolvedValue({
      customerInfo: customerInfo({ activeEntitlements: { plus: {} }, managementURL: 'https://play.google.com/store/account/subscriptions' }),
    });
    const info = await getCustomerInfo();
    expect(info).toEqual({
      activeEntitlementIds: ['plus'],
      activePlanCode: 'plus',
      managementUrl: 'https://play.google.com/store/account/subscriptions',
    });
  });

  it('registers the CustomerInfo listener at most once', async () => {
    const onUpdate = vi.fn();
    await addCustomerInfoListener(onUpdate);
    await addCustomerInfoListener(onUpdate);
    expect(mockAddCustomerInfoUpdateListener).toHaveBeenCalledTimes(1);
  });
});

describe('revenueCatClient on Android — getManagementUrl (gates the manage-subscription UI)', () => {
  it('is null when the customer has no management URL — a screen must hide the button', async () => {
    await syncIdentity(USER_A);
    mockGetCustomerInfo.mockResolvedValue({ customerInfo: customerInfo({ managementURL: null }) });
    await expect(getManagementUrl()).resolves.toBeNull();
  });

  it('returns the real store URL when present', async () => {
    await syncIdentity(USER_A);
    mockGetCustomerInfo.mockResolvedValue({ customerInfo: customerInfo({ managementURL: 'https://play.google.com/store/account/subscriptions' }) });
    await expect(getManagementUrl()).resolves.toBe('https://play.google.com/store/account/subscriptions');
  });
});

describe('revenueCatClient on Android — getOfferings', () => {
  it('returns an empty list when there is no current offering (the expected state before Google Play products exist)', async () => {
    await syncIdentity(USER_A);
    mockGetOfferings.mockResolvedValue({ current: null });
    await expect(getOfferings()).resolves.toEqual([]);
  });

  it('maps the current offering\'s packages to OrodimProductOffering', async () => {
    await syncIdentity(USER_A);
    mockGetOfferings.mockResolvedValue({
      current: {
        availablePackages: [
          {
            product: {
              identifier: 'orodim.subscription.essential.monthly',
              title: 'Essencial',
              description: '30 minutos de conversação por mês',
              priceString: 'R$ 34,90',
            },
          },
        ],
      },
    });
    const offerings = await getOfferings();
    expect(offerings).toEqual([
      {
        productId: 'orodim.subscription.essential.monthly',
        title: 'Essencial',
        description: '30 minutos de conversação por mês',
        priceFormatted: 'R$ 34,90',
      },
    ]);
  });
});

describe('revenueCatClient on Android — purchaseProduct', () => {
  const PRODUCT_ID = 'orodim.subscription.essential.monthly';

  async function loadOneOffering() {
    mockGetOfferings.mockResolvedValue({
      current: {
        availablePackages: [{ product: { identifier: PRODUCT_ID, title: 'Essencial', description: '', priceString: 'R$ 34,90' } }],
      },
    });
    await getOfferings();
  }

  it('rejects a product id not present in the last getOfferings() cache', async () => {
    await syncIdentity(USER_A);
    const result = await purchaseProduct(PRODUCT_ID);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('unknown');
    expect(mockPurchasePackage).not.toHaveBeenCalled();
  });

  it('a completed purchase returns ok:true with the mapped customerInfo', async () => {
    await syncIdentity(USER_A);
    await loadOneOffering();
    mockPurchasePackage.mockResolvedValue({ customerInfo: customerInfo({ activeEntitlements: { essential: {} } }) });
    const result = await purchaseProduct(PRODUCT_ID);
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
    const result = await purchaseProduct(PRODUCT_ID);
    expect(result.ok).toBe(false);
    expect(result.error).toEqual({ code: 'user_cancelled', message: 'Compra cancelada.' });
  });

  it('a cancelled purchase (error code form) also maps to user_cancelled', async () => {
    await syncIdentity(USER_A);
    await loadOneOffering();
    mockPurchasePackage.mockRejectedValue({ code: 'PURCHASE_CANCELLED_ERROR' });
    const result = await purchaseProduct(PRODUCT_ID);
    expect(result.error?.code).toBe('user_cancelled');
  });

  it('a generic/unexpected purchase error maps to unknown, never leaks the raw SDK error', async () => {
    await syncIdentity(USER_A);
    await loadOneOffering();
    mockPurchasePackage.mockRejectedValue({ code: 'SOME_OTHER_ERROR', message: 'boom' });
    const result = await purchaseProduct(PRODUCT_ID);
    expect(result).toEqual({
      ok: false,
      customerInfo: null,
      error: { code: 'unknown', message: 'Não foi possível concluir a compra. Tente novamente.' },
    });
  });

  it('returns not_configured before the SDK has been configured', async () => {
    const result = await purchaseProduct(PRODUCT_ID);
    expect(result.error?.code).toBe('not_configured');
    expect(mockPurchasePackage).not.toHaveBeenCalled();
  });
});

describe('revenueCatClient on Android — restorePurchases', () => {
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
