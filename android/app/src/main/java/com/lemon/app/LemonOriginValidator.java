package com.lemon.app;

import java.net.URI;
import java.net.URISyntaxException;

/**
 * Exact-match origin check (scheme + host + default port) shared by
 * LemonNativePlugin. Deliberately implemented with java.net.URI instead of
 * android.net.Uri so this logic is a plain, testable Java unit — no
 * Robolectric/instrumentation needed to exercise it (see
 * android/app/src/test/java/com/lemon/app/LemonOriginValidatorTest.java).
 *
 * Mirrors the same exact-match convention LemonWebViewClient already
 * enforces for navigation: no substring/contains matching, no subdomain
 * matching, no scheme other than https, no non-default port.
 */
final class LemonOriginValidator {

    private LemonOriginValidator() {}

    /**
     * @param allowedHost the single trusted hostname (e.g. "my.lemonenglish.app"),
     *                     normally read from the bridge's own configured server.url.
     * @param currentUrl   the WebView's current top-level URL.
     * @return true only if currentUrl is exactly https://{allowedHost} on the
     *         default port — false for any other scheme, host, port, or
     *         unparseable/missing input.
     */
    static boolean isTrusted(String allowedHost, String currentUrl) {
        if (allowedHost == null || allowedHost.isEmpty() || currentUrl == null || currentUrl.isEmpty()) {
            return false;
        }

        URI uri;
        try {
            uri = new URI(currentUrl);
        } catch (URISyntaxException e) {
            return false;
        }

        String scheme = uri.getScheme();
        String host = uri.getHost();
        int port = uri.getPort(); // -1 means "no explicit port" i.e. the scheme default

        return "https".equalsIgnoreCase(scheme) && allowedHost.equalsIgnoreCase(host) && port == -1;
    }
}
