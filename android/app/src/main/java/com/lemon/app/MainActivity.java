package com.lemon.app;

import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.ImageView;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import java.util.concurrent.atomic.AtomicBoolean;

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
 *
 * Splash: the OS-native/backported SplashScreen (installSplashScreen below)
 * only covers the brief pre-Activity starting-window phase and shows the
 * launcher icon — see styles.xml for why. It is deliberately left to
 * dismiss on its own default condition (first frame drawn), NOT gated on
 * contentReady — gating both on the same flag was tried first and failed
 * live: setKeepOnScreenCondition keeps the NATIVE splash (icon only) drawn
 * on top of the Activity for as long as it's true, which hid this overlay
 * completely for its entire lifetime. The real splash — the full logo+
 * "Lemon" wordmark image, uncropped — is splashOverlay below, a plain
 * centered ImageView with no icon-slot size/shape constraint, added in the
 * same frame as the native splash's last one so there's no gap, and kept
 * on screen by its own visibility, independent of the native API, until
 * contentReady.
 */
public class MainActivity extends BridgeActivity {

    private static final long SPLASH_MAX_WAIT_MS = 6000;

    private final AtomicBoolean overlayRemoved = new AtomicBoolean(false);
    private View splashOverlay;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Must run before super.onCreate() to actually take over the launch theme.
        // No setKeepOnScreenCondition — left at its default (dismiss once the
        // first frame is drawn), intentionally, see the class doc above.
        SplashScreen.installSplashScreen(this);

        super.onCreate(savedInstanceState);

        splashOverlay = buildSplashOverlay();
        addContentView(
            splashOverlay,
            new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        );

        // Backstop: never let a slow/hung load hold the splash indefinitely —
        // whatever the WebView has on screen (real content, or Capacitor's own
        // errorPath fallback, which fires its own onPageCommitVisible first in
        // the normal case) takes over after this regardless.
        new Handler(Looper.getMainLooper()).postDelayed(this::dismissSplash, SPLASH_MAX_WAIT_MS);
    }

    private View buildSplashOverlay() {
        FrameLayout overlay = new FrameLayout(this);
        overlay.setBackgroundColor(getColor(R.color.ic_launcher_background));

        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.splash_icon);
        logo.setScaleType(ImageView.ScaleType.CENTER_INSIDE); // never crops, never stretches, never upscales
        FrameLayout.LayoutParams logoParams = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        );
        logoParams.gravity = Gravity.CENTER;
        // Safe margin so the mark never touches screen edges on any size/aspect.
        int margin = (int) (48 * getResources().getDisplayMetrics().density);
        logoParams.setMargins(margin, margin, margin, margin);
        overlay.addView(logo, logoParams);

        return overlay;
    }

    private void dismissSplash() {
        if (overlayRemoved.compareAndSet(false, true)) {
            runOnUiThread(() -> {
                if (splashOverlay != null && splashOverlay.getParent() != null) {
                    ((ViewGroup) splashOverlay.getParent()).removeView(splashOverlay);
                }
            });
        }
    }

    @Override
    protected void load() {
        super.load();

        Bridge bridge = getBridge();

        // onPageCommitVisible fires once there's something real to paint — for
        // either the production site or, after a failed load, the local
        // errorPath fallback page Capacitor switches to on its own. Only
        // dismissing here (never on the error callback itself) avoids a gap
        // where the splash is gone but the fallback hasn't painted yet.
        bridge.addWebViewListener(new WebViewListener() {
            @Override
            public void onPageCommitVisible(WebView view, String url) {
                dismissSplash();
            }
        });

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
