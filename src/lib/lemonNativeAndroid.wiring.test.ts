/**
 * Static source-text assertions on the Android native side of LemonNative.
 *
 * This repo has no Robolectric/instrumented-test setup for the Android app
 * module (only plain JUnit local unit tests, see
 * android/app/src/test/java/com/lemon/app/LemonOriginValidatorTest.java for
 * the parts of the native side that ARE runtime-testable without an
 * Android framework). Reading the .java sources as text and asserting on
 * them is the same established precedent this repo already uses for
 * wiring that can't be exercised without a full render/runtime harness
 * (see src/components/__tests__/RewriteSection-wiring.test.ts). The exact
 * JSON the plugin returns on a real device, plus appVersion matching the
 * installed package, is additionally confirmed live via Chrome DevTools
 * against the running emulator (see the task's runtime verification step).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const PLUGIN_PATH = resolve(__dirname, '..', '..', 'android/app/src/main/java/com/lemon/app/LemonNativePlugin.java');
const MAIN_ACTIVITY_PATH = resolve(__dirname, '..', '..', 'android/app/src/main/java/com/lemon/app/MainActivity.java');

const pluginSrc = readFileSync(PLUGIN_PATH, 'utf8');
const mainActivitySrc = readFileSync(MAIN_ACTIVITY_PATH, 'utf8');

describe('LemonNativePlugin.java — registration', () => {
  it('is annotated as a Capacitor plugin named exactly "LemonNative"', () => {
    expect(pluginSrc).toMatch(/@CapacitorPlugin\(name\s*=\s*"LemonNative"\)/);
  });

  it('exposes exactly one @PluginMethod: getCapabilities (no other native methods yet)', () => {
    const methodMatches = pluginSrc.match(/@PluginMethod/g) ?? [];
    expect(methodMatches).toHaveLength(1);
    expect(pluginSrc).toMatch(/@PluginMethod[\s\S]{0,40}public void getCapabilities\(PluginCall call\)/);
  });

  it('is registered in MainActivity before super.onCreate(), so it is available in the Bridge for the initial page load', () => {
    const registerIndex = mainActivitySrc.indexOf('registerPlugin(LemonNativePlugin.class)');
    const superOnCreateIndex = mainActivitySrc.indexOf('super.onCreate(savedInstanceState)');
    expect(registerIndex, 'registerPlugin(LemonNativePlugin.class) not found in MainActivity.java').toBeGreaterThan(-1);
    expect(superOnCreateIndex, 'super.onCreate(savedInstanceState) not found in MainActivity.java').toBeGreaterThan(-1);
    expect(registerIndex).toBeLessThan(superOnCreateIndex);
  });
});

describe('LemonNativePlugin.java — result schema (bridgeVersion is exactly 1, all feature flags false)', () => {
  it('sets bridgeVersion to the literal 1 (this is the first bridge version)', () => {
    expect(pluginSrc).toMatch(/BRIDGE_VERSION\s*=\s*1\b/);
    expect(pluginSrc).toMatch(/"bridgeVersion"\s*,\s*BRIDGE_VERSION/);
  });

  it('sets platform to the literal "android" and isNative to true', () => {
    expect(pluginSrc).toMatch(/"platform"\s*,\s*"android"/);
    expect(pluginSrc).toMatch(/"isNative"\s*,\s*true\)/);
  });

  it('includes every field from the shared LemonNativeCapabilities contract', () => {
    for (const field of [
      'platform',
      'isNative',
      'appVersion',
      'bridgeVersion',
      'googleLogin',
      'appleLogin',
      'playBilling',
      'appStoreBilling',
      'pushNotifications',
    ]) {
      expect(pluginSrc, `missing field "${field}" in the result JSObject`).toMatch(new RegExp(`"${field}"`));
    }
  });

  it('hardcodes every not-yet-implemented capability flag to false — none can accidentally read true', () => {
    for (const flag of ['googleLogin', 'appleLogin', 'playBilling', 'appStoreBilling', 'pushNotifications']) {
      expect(pluginSrc).toMatch(new RegExp(`"${flag}"\\s*,\\s*false\\)`));
    }
  });

  it('does NOT hardcode appVersion as a string literal — it must be read from installed package metadata', () => {
    expect(pluginSrc).not.toMatch(/"appVersion"\s*,\s*"[^"]/);
    expect(pluginSrc).toMatch(/getPackageInfo|PackageManager|versionName/);
  });
});

describe('LemonNativePlugin.java — trusted-origin gate', () => {
  it('rejects with the stable, non-sensitive UNTRUSTED_ORIGIN error before resolving any call', () => {
    expect(pluginSrc).toMatch(/call\.reject\("UNTRUSTED_ORIGIN"\)/);
  });

  it('does not log the actual URL/origin value (only a static message) when rejecting', () => {
    const rejectionLogMatch = pluginSrc.match(/Log\.\w+\([^)]*\)/g) ?? [];
    for (const call of rejectionLogMatch) {
      expect(call).not.toMatch(/getUrl\(\)|currentUrl|serverUrl/);
    }
  });
});
