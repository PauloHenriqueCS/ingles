import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above imports by vitest; vi.hoisted() makes
// these mock fns available inside the factory below (see pronunciationRecorder.test.ts
// for the same pattern used elsewhere in this repo).
const { mockIsNativePlatform, mockIsPluginAvailable, mockGetCapabilities, mockRegisterPlugin } = vi.hoisted(() => {
  return {
    mockIsNativePlatform: vi.fn(),
    mockIsPluginAvailable: vi.fn(),
    mockGetCapabilities: vi.fn(),
    mockRegisterPlugin: vi.fn(),
  };
});

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: mockIsNativePlatform,
    isPluginAvailable: mockIsPluginAvailable,
  },
  registerPlugin: mockRegisterPlugin.mockReturnValue({
    getCapabilities: mockGetCapabilities,
  }),
}));

import { getLemonNativeCapabilities } from './lemonNative';

describe('getLemonNativeCapabilities — browser/web fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns platform "web" when not running inside a native app', async () => {
    mockIsNativePlatform.mockReturnValue(false);

    const result = await getLemonNativeCapabilities();

    expect(result.platform).toBe('web');
  });

  it('returns bridgeVersion 0 in the web fallback', async () => {
    mockIsNativePlatform.mockReturnValue(false);

    const result = await getLemonNativeCapabilities();

    expect(result.bridgeVersion).toBe(0);
  });

  it('reports every native-only capability as false, isNative false, and appVersion null', async () => {
    mockIsNativePlatform.mockReturnValue(false);

    const result = await getLemonNativeCapabilities();

    expect(result.isNative).toBe(false);
    expect(result.appVersion).toBeNull();
    expect(result.googleLogin).toBe(false);
    expect(result.appleLogin).toBe(false);
    expect(result.playBilling).toBe(false);
    expect(result.appStoreBilling).toBe(false);
    expect(result.pushNotifications).toBe(false);
  });

  it('does not call the native plugin at all when not on a native platform', async () => {
    mockIsNativePlatform.mockReturnValue(false);

    await getLemonNativeCapabilities();

    expect(mockGetCapabilities).not.toHaveBeenCalled();
  });
});

describe('getLemonNativeCapabilities — missing/unavailable native plugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to the web result without throwing when the native platform has no LemonNative plugin registered (older app build)', async () => {
    mockIsNativePlatform.mockReturnValue(true);
    mockIsPluginAvailable.mockReturnValue(false);

    await expect(getLemonNativeCapabilities()).resolves.toEqual(
      expect.objectContaining({ platform: 'web', isNative: false, bridgeVersion: 0 })
    );
  });

  it('never invokes getCapabilities() when the plugin is unavailable', async () => {
    mockIsNativePlatform.mockReturnValue(true);
    mockIsPluginAvailable.mockReturnValue(false);

    await getLemonNativeCapabilities();

    expect(mockGetCapabilities).not.toHaveBeenCalled();
  });
});

describe('getLemonNativeCapabilities — native call rejection fails closed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves to the web fallback (never throws/rejects) when the native call rejects, e.g. UNTRUSTED_ORIGIN', async () => {
    mockIsNativePlatform.mockReturnValue(true);
    mockIsPluginAvailable.mockReturnValue(true);
    mockGetCapabilities.mockRejectedValue(new Error('UNTRUSTED_ORIGIN'));

    const result = await getLemonNativeCapabilities();

    expect(result.platform).toBe('web');
    expect(result.isNative).toBe(false);
    expect(result.bridgeVersion).toBe(0);
  });

  it('never reports a capability as true just because the platform is native — a rejection still yields all-false capabilities', async () => {
    mockIsNativePlatform.mockReturnValue(true);
    mockIsPluginAvailable.mockReturnValue(true);
    mockGetCapabilities.mockRejectedValue(new Error('boom'));

    const result = await getLemonNativeCapabilities();

    expect(result.googleLogin).toBe(false);
    expect(result.appleLogin).toBe(false);
    expect(result.playBilling).toBe(false);
    expect(result.appStoreBilling).toBe(false);
    expect(result.pushNotifications).toBe(false);
  });
});

describe('getLemonNativeCapabilities — successful native resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns exactly what the native plugin resolves, unmodified, when it succeeds', async () => {
    mockIsNativePlatform.mockReturnValue(true);
    mockIsPluginAvailable.mockReturnValue(true);
    mockGetCapabilities.mockResolvedValue({
      platform: 'android',
      isNative: true,
      appVersion: '1.0',
      bridgeVersion: 1,
      googleLogin: false,
      appleLogin: false,
      playBilling: false,
      appStoreBilling: false,
      pushNotifications: false,
    });

    const result = await getLemonNativeCapabilities();

    expect(result).toEqual({
      platform: 'android',
      isNative: true,
      appVersion: '1.0',
      bridgeVersion: 1,
      googleLogin: false,
      appleLogin: false,
      playBilling: false,
      appStoreBilling: false,
      pushNotifications: false,
    });
  });
});
