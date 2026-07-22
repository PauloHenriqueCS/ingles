import { Capacitor, registerPlugin } from '@capacitor/core';

export type LemonNativePlatform = 'android' | 'ios' | 'web';

export interface LemonNativeCapabilities {
  platform: LemonNativePlatform;
  isNative: boolean;
  appVersion: string | null;
  bridgeVersion: number;

  googleLogin: boolean;
  appleLogin: boolean;
  playBilling: boolean;
  appStoreBilling: boolean;
  pushNotifications: boolean;
}

export interface LemonNativePlugin {
  getCapabilities(): Promise<LemonNativeCapabilities>;
}

/**
 * Native implementations of this exact plugin name/shape:
 *  - Android: android/app/src/main/java/com/lemon/app/LemonNativePlugin.java
 *    (registered in MainActivity.java before super.onCreate()).
 *  - iOS: not implemented yet — no ios/ platform exists (this repo is
 *    developed on Windows). A future Swift plugin must register under this
 *    same name ("LemonNative"), implement getCapabilities() with this same
 *    LemonNativeCapabilities shape, and return platform: 'ios'. It belongs
 *    at ios/App/App/LemonNativePlugin.swift once that platform is added.
 *
 * No manual addJavascriptInterface, no generic command/execution surface —
 * this is the only method this bridge exposes.
 */
const LemonNative = registerPlugin<LemonNativePlugin>('LemonNative');

const WEB_FALLBACK_CAPABILITIES: LemonNativeCapabilities = {
  platform: 'web',
  isNative: false,
  appVersion: null,
  bridgeVersion: 0,
  googleLogin: false,
  appleLogin: false,
  playBilling: false,
  appStoreBilling: false,
  pushNotifications: false,
};

/**
 * Safe, application-facing entry point — call this instead of touching
 * LemonNative/Capacitor directly elsewhere in the app.
 *
 * Fails closed: a missing plugin (older app build, browser, unsupported
 * platform) or a rejected native call both resolve to the same web fallback
 * rather than throwing or reporting any capability the native side didn't
 * explicitly confirm. Never uses user-agent sniffing — platform detection
 * goes through Capacitor's own runtime checks only.
 */
export async function getLemonNativeCapabilities(): Promise<LemonNativeCapabilities> {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('LemonNative')) {
    return WEB_FALLBACK_CAPABILITIES;
  }

  try {
    return await LemonNative.getCapabilities();
  } catch {
    return WEB_FALLBACK_CAPABILITIES;
  }
}
