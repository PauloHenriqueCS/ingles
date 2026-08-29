/**
 * Client-side "push opened" reporting for behavioral push. Kept tiny and
 * resilient:
 *   - Only the behavioral_push_event_id is ever persisted locally (never the
 *     whole payload) — enough to report the open after a cold start where the
 *     click listener fires BEFORE the Supabase session has finished restoring.
 *   - Reporting is idempotent server-side (first open wins), so retries are
 *     safe. A terminal outcome (200 ok, or 403/404 — not ours / gone) drops the
 *     id from the queue; a transient one (401 no-session-yet, network, 5xx)
 *     keeps it for the next flush (e.g. right after login).
 *
 * The actual OneSignal click listener is wired in the app shell
 * (useBehavioralPushOpenSync) — this module has no OneSignal dependency.
 */

import { getAuthHeader } from '../apiAuth';

const PENDING_KEY = 'behavioral_push_pending_opens';
const OPEN_ENDPOINT = '/api/behavioral-push/open';

function readPending(): string[] {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writePending(ids: string[]): void {
  try {
    if (ids.length === 0) localStorage.removeItem(PENDING_KEY);
    else localStorage.setItem(PENDING_KEY, JSON.stringify(Array.from(new Set(ids))));
  } catch {
    // ignore — best effort
  }
}

function queuePendingOpen(eventId: string): void {
  const ids = readPending();
  if (!ids.includes(eventId)) writePending([...ids, eventId]);
}

function removePendingOpen(eventId: string): void {
  writePending(readPending().filter((id) => id !== eventId));
}

/**
 * POST the open to the backend. Returns:
 *   'done'      → recorded (or terminally not-ours/gone); drop from queue.
 *   'retry'     → transient (no session yet / network / 5xx); keep queued.
 */
async function postOpen(eventId: string): Promise<'done' | 'retry'> {
  let auth: Record<string, string>;
  try {
    auth = await getAuthHeader();
  } catch {
    return 'retry';
  }
  if (!auth.Authorization) return 'retry'; // session not ready — try again later

  try {
    const resp = await fetch(OPEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ behavioral_push_event_id: eventId }),
    });
    // 200 ok, or 403/404 → terminal (retrying won't change the outcome).
    if (resp.ok || resp.status === 403 || resp.status === 404) return 'done';
    // 401 (session invalid) / 5xx → transient.
    return 'retry';
  } catch {
    return 'retry';
  }
}

/** Report a single open now, persisting it first so a cold-start tap that
 *  precedes auth restoration is never lost. */
export async function recordBehavioralPushOpen(eventId: string): Promise<void> {
  if (!eventId) return;
  queuePendingOpen(eventId);
  const outcome = await postOpen(eventId);
  if (outcome === 'done') removePendingOpen(eventId);
}

/** Flush every queued open (call once the Supabase session is available). */
export async function flushPendingBehavioralPushOpens(): Promise<void> {
  const ids = readPending();
  for (const id of ids) {
    const outcome = await postOpen(id);
    if (outcome === 'done') removePendingOpen(id);
  }
}
