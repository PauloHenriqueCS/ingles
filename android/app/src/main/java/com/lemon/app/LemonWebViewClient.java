package com.lemon.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.util.Locale;

/**
 * Restricts in-app navigation to exactly https://{allowedHost} (the value of
 * server.url in capacitor.config.ts — a single source, not duplicated here).
 *
 * Capacitor's own allowNavigation/launchIntent only compares the request's
 * host against the configured mask and does NOT check scheme — an
 * http://{allowedHost} navigation passes it. That's not sufficient on its
 * own (see capacitor.config.ts comment), so this class is the actual
 * enforcement point: exact scheme + exact host + default port, or the
 * request is handed to an external app (a small explicit scheme allowlist)
 * or dropped outright. Everything else BridgeWebViewClient already does
 * (local-asset serving, the errorPath offline fallback, bridge reset) is
 * inherited unmodified.
 */
public class LemonWebViewClient extends BridgeWebViewClient {

    private final Bridge bridge;
    private final String allowedHost;

    public LemonWebViewClient(Bridge bridge, String allowedHost) {
        super(bridge);
        this.bridge = bridge;
        this.allowedHost = allowedHost;
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        String scheme = uri.getScheme() != null ? uri.getScheme().toLowerCase(Locale.US) : "";
        String host = uri.getHost() != null ? uri.getHost().toLowerCase(Locale.US) : "";

        // Exact match only — no subdomains, no lookalike hosts, no wildcards.
        // uri.getPort() == -1 means "no explicit port", i.e. the scheme default (443 for https).
        if ("https".equals(scheme) && allowedHost.equals(host) && uri.getPort() == -1) {
            return false; // stays in this WebView
        }

        // A small, explicit allowlist of schemes we hand off to the system —
        // never loaded inside this WebView, never reaching the bridge.
        if ("https".equals(scheme) || "http".equals(scheme) || "mailto".equals(scheme) || "tel".equals(scheme)) {
            try {
                view.getContext().startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (ActivityNotFoundException ignored) {
                // No app can handle it — nothing to fall back to, just drop it.
            }
            return true;
        }

        // javascript:, file:, content:, blob:, data:, intent:, and anything
        // unrecognized — blocked outright. None of this app's features need
        // the WebView itself to navigate to one of these as a top-level URL.
        return true;
    }

    @Override
    public void onReceivedSslError(WebView view, SslErrorHandler handler, android.net.http.SslError error) {
        // Never proceed past a certificate error. Cancelling here, rather than
        // deferring to the default WebViewClient behavior, makes the "always
        // reject" contract explicit and independent of platform defaults.
        handler.cancel();
        String errorUrl = bridge.getErrorUrl();
        if (errorUrl != null) {
            view.loadUrl(errorUrl);
        }
    }
}
