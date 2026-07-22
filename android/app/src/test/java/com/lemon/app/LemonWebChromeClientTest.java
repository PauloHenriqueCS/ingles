package com.lemon.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.webkit.PermissionRequest;
import org.junit.Test;

/**
 * Plain JUnit tests (no Robolectric/instrumentation) for
 * LemonWebChromeClient.isAllowedMediaRequest — the origin+resource gate that
 * onPermissionRequest applies before ever touching the Android runtime
 * permission flow. Mirrors LemonOriginValidatorTest's exact-match rigor.
 */
public class LemonWebChromeClientTest {

    private static final String ALLOWED_ORIGIN = "https://my.lemonenglish.app";
    private static final String[] AUDIO_ONLY = { PermissionRequest.RESOURCE_AUDIO_CAPTURE };
    private static final String[] VIDEO_ONLY = { PermissionRequest.RESOURCE_VIDEO_CAPTURE };
    private static final String[] AUDIO_AND_VIDEO = {
        PermissionRequest.RESOURCE_AUDIO_CAPTURE,
        PermissionRequest.RESOURCE_VIDEO_CAPTURE,
    };

    @Test
    public void allowsTheExactOriginRequestingAudio() {
        assertTrue(LemonWebChromeClient.isAllowedMediaRequest(ALLOWED_ORIGIN, "https://my.lemonenglish.app", AUDIO_ONLY));
    }

    @Test
    public void allowsAudioPlusVideoRequestFromTheExactOrigin() {
        // The caller only ever grants RESOURCE_AUDIO_CAPTURE regardless — this
        // just confirms the gate itself doesn't reject the combined request.
        assertTrue(LemonWebChromeClient.isAllowedMediaRequest(ALLOWED_ORIGIN, "https://my.lemonenglish.app", AUDIO_AND_VIDEO));
    }

    @Test
    public void toleratesATrailingSlashOnTheRequestOrigin() {
        assertTrue(LemonWebChromeClient.isAllowedMediaRequest(ALLOWED_ORIGIN, "https://my.lemonenglish.app/", AUDIO_ONLY));
    }

    @Test
    public void rejectsAVideoOnlyRequestFromTheExactOrigin() {
        assertFalse(LemonWebChromeClient.isAllowedMediaRequest(ALLOWED_ORIGIN, "https://my.lemonenglish.app", VIDEO_ONLY));
    }

    @Test
    public void rejectsHttpForTheSameHost() {
        assertFalse(LemonWebChromeClient.isAllowedMediaRequest(ALLOWED_ORIGIN, "http://my.lemonenglish.app", AUDIO_ONLY));
    }

    @Test
    public void rejectsADeceptiveSubdomain() {
        assertFalse(LemonWebChromeClient.isAllowedMediaRequest(ALLOWED_ORIGIN, "https://my.lemonenglish.app.evil.com", AUDIO_ONLY));
    }

    @Test
    public void rejectsALookalikeParentDomain() {
        assertFalse(LemonWebChromeClient.isAllowedMediaRequest(ALLOWED_ORIGIN, "https://evil.my.lemonenglish.app", AUDIO_ONLY));
    }

    @Test
    public void rejectsANonDefaultPort() {
        assertFalse(LemonWebChromeClient.isAllowedMediaRequest(ALLOWED_ORIGIN, "https://my.lemonenglish.app:8443", AUDIO_ONLY));
    }

    @Test
    public void rejectsACompletelyDifferentOrigin() {
        assertFalse(LemonWebChromeClient.isAllowedMediaRequest(ALLOWED_ORIGIN, "https://evil.com", AUDIO_ONLY));
    }

    @Test
    public void rejectsANullOrigin() {
        assertFalse(LemonWebChromeClient.isAllowedMediaRequest(ALLOWED_ORIGIN, null, AUDIO_ONLY));
    }

    @Test
    public void rejectsAnEmptyOrigin() {
        assertFalse(LemonWebChromeClient.isAllowedMediaRequest(ALLOWED_ORIGIN, "", AUDIO_ONLY));
    }

    @Test
    public void rejectsAnEmptyResourceList() {
        assertFalse(LemonWebChromeClient.isAllowedMediaRequest(ALLOWED_ORIGIN, "https://my.lemonenglish.app", new String[0]));
    }

    @Test
    public void rejectsANullResourceList() {
        assertFalse(LemonWebChromeClient.isAllowedMediaRequest(ALLOWED_ORIGIN, "https://my.lemonenglish.app", null));
    }
}
