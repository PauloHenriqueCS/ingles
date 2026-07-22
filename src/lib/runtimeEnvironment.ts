import { Capacitor } from '@capacitor/core';

/**
 * Single place the app asks "am I native, and can I use plugin X". Not a
 * security boundary — Capacitor.getPlatform()/isNativePlatform() read a
 * JS-side value a malicious page could in principle spoof. Real access
 * control lives natively (LemonWebViewClient/LemonWebChromeClient); this is
 * purely for choosing UI behavior (back-button handling, status bar, layout).
 */
export type Platform = 'android' | 'ios' | 'web';

export const platform = Capacitor.getPlatform() as Platform;
export const isNativeApp = Capacitor.isNativePlatform();
export const isAndroidApp = isNativeApp && platform === 'android';
export const isIOSApp = isNativeApp && platform === 'ios';
export const isWeb = !isNativeApp;

export function isPluginAvailable(name: string): boolean {
  return Capacitor.isPluginAvailable(name);
}

/** Non-sensitive UI/layout hook only — see the module doc comment above. */
export function runtimeAttribute(): 'android-app' | 'ios-app' | 'web' {
  if (isAndroidApp) return 'android-app';
  if (isIOSApp) return 'ios-app';
  return 'web';
}
