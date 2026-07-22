package com.lemon.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.lang.reflect.Method;
import org.junit.Test;

/**
 * Plain JUnit local unit tests (no Robolectric/instrumentation) for the
 * exact-match origin check LemonNativePlugin gates every call on.
 * LemonOriginValidator is package-private with a package-private static
 * method, so reflection is used to invoke it without widening its
 * visibility just for tests.
 */
public class LemonOriginValidatorTest {

    private static final String ALLOWED_HOST = "my.lemonenglish.app";

    private boolean isTrusted(String allowedHost, String currentUrl) throws Exception {
        Method method = LemonOriginValidator.class.getDeclaredMethod("isTrusted", String.class, String.class);
        method.setAccessible(true);
        return (boolean) method.invoke(null, allowedHost, currentUrl);
    }

    @Test
    public void acceptsTheExactTrustedOrigin() throws Exception {
        assertTrue(isTrusted(ALLOWED_HOST, "https://my.lemonenglish.app/"));
    }

    @Test
    public void acceptsTheExactTrustedOriginWithAPathAndQuery() throws Exception {
        assertTrue(isTrusted(ALLOWED_HOST, "https://my.lemonenglish.app/day?date=2026-07-22"));
    }

    @Test
    public void rejectsHttp() throws Exception {
        assertFalse(isTrusted(ALLOWED_HOST, "http://my.lemonenglish.app/"));
    }

    @Test
    public void rejectsADeceptiveSubdomain() throws Exception {
        assertFalse(isTrusted(ALLOWED_HOST, "https://my.lemonenglish.app.evil.com/"));
    }

    @Test
    public void rejectsALookalikeParentDomain() throws Exception {
        assertFalse(isTrusted(ALLOWED_HOST, "https://evil.my.lemonenglish.app/"));
    }

    @Test
    public void rejectsTheTrustedHostnameAppearingOnlyInThePath() throws Exception {
        assertFalse(isTrusted(ALLOWED_HOST, "https://evil.com/my.lemonenglish.app"));
    }

    @Test
    public void rejectsTheTrustedHostnameAppearingOnlyInTheQuery() throws Exception {
        assertFalse(isTrusted(ALLOWED_HOST, "https://evil.com/?redirect=my.lemonenglish.app"));
    }

    @Test
    public void rejectsAUserinfoTrick() throws Exception {
        // Everything before '@' is userinfo, not the host — the real host here is evil.com.
        assertFalse(isTrusted(ALLOWED_HOST, "https://my.lemonenglish.app@evil.com/"));
    }

    @Test
    public void rejectsANonDefaultPort() throws Exception {
        assertFalse(isTrusted(ALLOWED_HOST, "https://my.lemonenglish.app:8443/"));
    }

    @Test
    public void rejectsAMissingUrl() throws Exception {
        assertFalse(isTrusted(ALLOWED_HOST, null));
    }

    @Test
    public void rejectsAnEmptyUrl() throws Exception {
        assertFalse(isTrusted(ALLOWED_HOST, ""));
    }

    @Test
    public void rejectsAnUnparseableUrl() throws Exception {
        assertFalse(isTrusted(ALLOWED_HOST, "not a url at all ://"));
    }

    @Test
    public void rejectsWhenNoAllowedHostIsConfigured() throws Exception {
        assertFalse(isTrusted(null, "https://my.lemonenglish.app/"));
    }
}
