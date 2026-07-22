package com.lemon.app;

import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

/**
 * Swaps in LemonWebViewClient/LemonWebChromeClient right after Capacitor's
 * own load() creates the Bridge, before the Activity becomes interactive —
 * the WebView's initial webView.loadUrl(appUrl) call is programmatic and
 * never goes through shouldOverrideUrlLoading, so nothing is missed by
 * doing the swap here rather than at construction time (which Capacitor's
 * Bridge.Builder doesn't expose a hook for anyway).
 *
 * The allowed host is read back from the bridge's own configured server URL
 * (capacitor.config.ts server.url) instead of being duplicated as a second
 * literal here.
 */
public class MainActivity extends BridgeActivity {

    @Override
    protected void load() {
        super.load();

        Bridge bridge = getBridge();
        String serverUrl = bridge.getServerUrl();
        if (serverUrl == null) {
            // Bundled-assets mode (no server.url configured) — nothing to restrict beyond
            // Capacitor's own defaults, which already scope the bridge to the local origin.
            return;
        }

        String allowedHost = Uri.parse(serverUrl).getHost();
        bridge.setWebViewClient(new LemonWebViewClient(bridge, allowedHost));
        bridge.getWebView().setWebChromeClient(new LemonWebChromeClient(bridge, serverUrl));
    }
}
