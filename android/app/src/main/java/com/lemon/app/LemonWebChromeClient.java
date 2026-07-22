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
        String normalizedOrigin = origin.endsWith("/") ? origin.substring(0, origin.length() - 1) : origin;

        boolean wantsAudio = false;
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                wantsAudio = true;
            }
        }

        if (!allowedOrigin.equals(normalizedOrigin) || !wantsAudio) {
            Log.w(TAG, "Denying media permission request from unauthorized origin or resource");
            request.deny();
            return;
        }

        String[] needed = { Manifest.permission.RECORD_AUDIO };
        if (PermissionHelper.hasPermissions(bridge.getContext(), needed)) {
            request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
            return;
        }

        this.pendingRequest = request;
        this.micPermissionLauncher.launch(needed);
    }
}
