import { useEffect, useRef } from 'react';
import { isOneSignalSupported, setNotificationClickHandler } from '../lib/push/onesignalClient';
import {
  recordBehavioralPushOpen,
  flushPendingBehavioralPushOpens,
} from '../lib/push/behavioralPushOpen';

/**
 * Wires the (single) OneSignal notification-click listener to behavioral push:
 *   - a tap carrying additionalData.behavioral_push_event_id navigates Home and
 *     reports the open (persisted first, so a cold-start tap that fires before
 *     the Supabase session restores is never lost);
 *   - queued opens are flushed whenever a session becomes available.
 *
 * Non-behavioral clicks (no behavioral_push_event_id) are ignored, leaving room
 * for other push types to add their own routing later.
 */
export function useBehavioralPushOpenSync(
  userId: string | undefined,
  onNavigateHome: () => void,
): void {
  const navRef = useRef(onNavigateHome);
  navRef.current = onNavigateHome;

  // Register the click listener once at boot (native-only). Catches a tap that
  // cold-starts the app.
  useEffect(() => {
    if (!isOneSignalSupported()) return;
    setNotificationClickHandler((payload) => {
      const data = payload.additionalData as Record<string, unknown> | null;
      const eventId = data?.behavioral_push_event_id;
      if (typeof eventId !== 'string' || eventId.length === 0) return;
      navRef.current();
      void recordBehavioralPushOpen(eventId);
    });
    return () => setNotificationClickHandler(null);
  }, []);

  // Flush queued opens once a session is available (covers the cold-start race).
  useEffect(() => {
    if (!userId) return;
    void flushPendingBehavioralPushOpens();
  }, [userId]);
}
