package com.lemon.app;

import android.Manifest;
import android.util.Log;
import android.webkit.PermissionRequest;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;
import com.getcapacitor.util.PermissionHelper;
import java.util.Map;

/**
 * Restricts getUserMedia() permission grants to exactly two things:
 *  - the requesting origin must be https://{allowedOrigin} — nothing else,
 *    ever, gets the native mic;
 *  - only RESOURCE_AUDIO_CAPTURE is ever granted, even if the page also
 *    asked for video — this app has no camera feature.
 *
 * BridgeWebChromeClient's default onPermissionRequest does neither check:
 * it grants whatever was requested to whichever origin asked. Everything
 * else (JS dialogs, file chooser, geolocation) is inherited unmodified.
 */
public class LemonWebChromeClient extends BridgeWebChromeClient {

    private static final String TAG = "LemonWebChromeClient";

    private final Bridge bridge;
    private final String allowedOrigin;
    private final ActivityResultLauncher<String[]> micPermissionLauncher;

    // Set immediately before launch() and consumed by the single registered
    // callback below — the launcher itself must be registered exactly once
    // (registerForActivityResult throws if called again after the activity
    // leaves CREATED state), so onPermissionRequest can't re-register per call.
    private PermissionRequest pendingRequest;

    public LemonWebChromeClient(Bridge bridge, String allowedOrigin) {
        super(bridge);
        this.bridge = bridge;
        // PermissionRequest.getOrigin() never has a trailing slash, but normalize defensively.
        this.allowedOrigin = allowedOrigin.endsWith("/") ? allowedOrigin.substring(0, allowedOrigin.length() - 1) : allowedOrigin;

        this.micPermissionLauncher = bridge.registerForActivityResult(
            new ActivityResultContracts.RequestMultiplePermissions(),
            (Map<String, Boolean> result) -> {
                PermissionRequest req = this.pendingRequest;
                this.pendingRequest = null;
                if (req == null) return;

                Boolean granted = result.get(Manifest.permission.RECORD_AUDIO);
                if (Boolean.TRUE.equals(granted)) {
                    req.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
                } else {
                    req.deny();
                }
            }
        );
    }

    @Override
    public void onPermissionRequest(final PermissionRequest request) {
        String origin = request.getOrigin() != null ? request.getOrigin().toString() : "";

        if (!isAllowedMediaRequest(allowedOrigin, origin, request.getResources())) {
            Log.w(TAG, "Denying media permission request from unauthorized origin or resource");
            request.deny();
            return;
        }

        // RECORD_AUDIO alone is not enough: Chromium's Android audio backend
        // (audio_manager_android.cc) also requires MODIFY_AUDIO_SETTINGS to open a
        // recording device, or it fails with "Unable to select audio device!" ->
        // getUserMedia() rejects with NotReadableError even though RECORD_AUDIO was
        // granted. MODIFY_AUDIO_SETTINGS is a normal-protection permission (declared
        // in AndroidManifest.xml, auto-granted at install, never prompted here) —
        // included in this array only so hasPermissions()/the launcher account for
        // it the same way BridgeWebChromeClient's own default onPermissionRequest
        // already does for AUDIO_CAPTURE.
        String[] needed = { Manifest.permission.RECORD_AUDIO, Manifest.permission.MODIFY_AUDIO_SETTINGS };
        if (PermissionHelper.hasPermissions(bridge.getContext(), needed)) {
            request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
            return;
        }

        this.pendingRequest = request;
        this.micPermissionLauncher.launch(needed);
    }

    /**
     * Pure origin+resource check, factored out of onPermissionRequest so it's
     * testable with plain JUnit (no PermissionRequest/WebView instance needed)
     * — see LemonWebChromeClientTest. Exact-match only: no subdomains, no
     * scheme/port other than what allowedOrigin already encodes, same
     * convention as LemonOriginValidator/LemonWebViewClient use elsewhere.
     * Returns true only if the origin matches exactly AND audio capture was
     * one of the requested resources (a page asking for audio+video still
     * passes here — the caller grants only RESOURCE_AUDIO_CAPTURE regardless
     * of what else was requested; a video-only request is rejected).
     */
    static boolean isAllowedMediaRequest(String allowedOrigin, String requestOrigin, String[] resources) {
        String normalizedOrigin = requestOrigin == null ? "" : requestOrigin;
        if (normalizedOrigin.endsWith("/")) {
            normalizedOrigin = normalizedOrigin.substring(0, normalizedOrigin.length() - 1);
        }

        boolean wantsAudio = false;
        if (resources != null) {
            for (String resource : resources) {
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                    wantsAudio = true;
                }
            }
        }

        return allowedOrigin.equals(normalizedOrigin) && wantsAudio;
    }
}
