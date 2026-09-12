import { platform, isNativeApp } from '../runtimeEnvironment';
import { supabase } from '../supabase';

/**
 * Persists the app-runtime platform (ios/android/web) and native app version for
 * the authenticated user — detected by the app's OWN runtime (Capacitor), NOT
 * inferred from AppsFlyer. This makes Supabase the central source for platform
 * analytics, independent of marketing attribution (which lives, separately, in
 * user_acquisition_attribution via AppsFlyer).
 *
 * One row per user (user_device_profile): first_seen is write-once server-side,
 * last_seen updates each session. Runs on ALL platforms (web included). Never
 * fabricates: the store app version only exists on native, so on web it is null.
 * Fail-safe — a telemetry failure never throws to the caller.
 */

// The store marketing version (e.g. "1.0.1"), uniform across iOS/Android via the
// @capacitor/app core plugin. Null on web (no store version — not invented) or
// when the plugin is unavailable (older build).
async function getRuntimeAppVersion(): Promise<string | null> {
  if (!isNativeApp) return null;
  try {
    const { App } = await import('@capacitor/app');
    const info = await App.getInfo();
    const v = (info?.version ?? '').trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export async function recordDeviceProfile(userId: string | null | undefined): Promise<void> {
  if (!userId) return;
  try {
    const appVersion = await getRuntimeAppVersion();
    await supabase.rpc('record_device_profile', {
      p_platform: platform, // 'ios' | 'android' | 'web' from Capacitor.getPlatform()
      p_app_version: appVersion, // null on web / when unavailable — never invented
    });
  } catch {
    // never throw from telemetry
  }
}
