package com.lemon.app;

import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.util.Log;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The first Lemon-specific native bridge. Deliberately minimal: a single
 * versioned capability query, no generic command/execution surface, no
 * manual addJavascriptInterface (registered through Capacitor's own plugin
 * system — see MainActivity.registerPlugin(LemonNativePlugin.class)).
 *
 * Every call is gated on the WebView's current top-level URL being exactly
 * https://{configured server host} — see isTrustedOrigin()/LemonOriginValidator
 * — mirroring the same exact-match convention LemonWebViewClient and
 * LemonWebChromeClient already use (never substring/contains, never
 * subdomain matching). This does not touch, replace, or relax that
 * existing navigation/mic enforcement in any way.
 */
@CapacitorPlugin(name = "LemonNative")
public class LemonNativePlugin extends Plugin {

    private static final String TAG = "LemonNativePlugin";
    private static final int BRIDGE_VERSION = 1;

    @PluginMethod
    public void getCapabilities(PluginCall call) {
        // Plugin methods run on Capacitor's own "CapacitorPlugins" thread, but
        // WebView.getUrl() (inside isTrustedOrigin()) must be called on the
        // main thread — calling it here directly throws
        // WebViewMethodCalledOnWrongThreadViolation and crashes the app.
        // PluginCall.resolve()/reject() are safe to invoke from the main
        // thread (Capacitor's own messaging handles the hop back to JS).
        getBridge().executeOnMainThread(() -> {
            if (!isTrustedOrigin()) {
                // Deliberately no URL/origin value in this log line — see the
                // class doc and LemonOriginValidator: only a static message,
                // never the actual page URL.
                Log.w(TAG, "Rejected getCapabilities() call from an untrusted WebView origin");
                call.reject("UNTRUSTED_ORIGIN");
                return;
            }

            JSObject result = new JSObject();
            result.put("platform", "android");
            result.put("isNative", true);
            result.put("appVersion", getAppVersion());
            result.put("bridgeVersion", BRIDGE_VERSION);
            result.put("googleLogin", false);
            result.put("appleLogin", false);
            result.put("playBilling", false);
            result.put("appStoreBilling", false);
            result.put("pushNotifications", false);
            call.resolve(result);
        });
    }

    private boolean isTrustedOrigin() {
        String serverUrl = getBridge().getServerUrl();
        if (serverUrl == null) {
            return false; // bundled-assets mode has no remote origin to trust
        }

        String allowedHost = Uri.parse(serverUrl).getHost();
        String currentUrl = getBridge().getWebView().getUrl();
        return LemonOriginValidator.isTrusted(allowedHost, currentUrl);
    }

    private String getAppVersion() {
        try {
            PackageManager pm = getContext().getPackageManager();
            PackageInfo info = pm.getPackageInfo(getContext().getPackageName(), 0);
            return info.versionName;
        } catch (PackageManager.NameNotFoundException e) {
            return null;
        }
    }
}
