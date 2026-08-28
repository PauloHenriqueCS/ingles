/**
 * CLIENT-SIDE diagnostic timing.
 *
 * The device is the only place that can observe a request STALL — the app shell
 * loads but a data call hangs "waiting on the API/DB", which is exactly the
 * "spinner forever" symptom reported in production. This module wraps fetch to
 * MEASURE every call (cheap) and POST only the slow/errored ones to
 * /api/debug/log, where the server drops them unless the dashboard log level is
 * on. It deliberately does NOT add a timeout or abort anything — the ask is to
 * find the bottleneck, not to paper over it.
 *
 * Zero static imports of supabase/apiAuth to avoid an import cycle (supabase.ts
 * consumes createInstrumentedFetch); the auth header is pulled lazily.
 */

/** Report a request only when it took at least this long (or failed). */
const SLOW_THRESHOLD_MS = 2000;
/** Hard cap on posts per page session so a bad incident can't self-amplify. */
const MAX_POSTS_PER_SESSION = 60;
/** Minimum gap between posts (ms) — light throttle. */
const MIN_POST_INTERVAL_MS = 250;

let postsSent = 0;
let lastPostAt = 0;

function shortPath(url: string): string {
  try {
    const u = new URL(url, 'http://x');
    return u.pathname.slice(0, 200);
  } catch {
    return String(url).split('?')[0].slice(0, 200);
  }
}

/** True for our own ingestion endpoint — never instrument or report it (loop). */
function isIngestionUrl(url: string): boolean {
  return url.includes('/api/debug/log');
}

interface ClientEvent {
  endpoint: string;
  stage: string;
  correlationId?: string;
  durationMs?: number;
  status?: number;
  errorCode?: string | null;
  detail?: Record<string, unknown>;
}

async function postDebugLog(event: ClientEvent): Promise<void> {
  const now = Date.now();
  if (postsSent >= MAX_POSTS_PER_SESSION) return;
  if (now - lastPostAt < MIN_POST_INTERVAL_MS) return;
  postsSent += 1;
  lastPostAt = now;
  try {
    // Lazy imports break the supabase.ts ↔ debugLog.ts cycle.
    const [{ getAuthHeader }, { apiUrl }] = await Promise.all([
      import('./apiAuth'),
      import('./apiUrl'),
    ]);
    const headers = await getAuthHeader();
    // Only authenticated sessions report (the server attributes rows to a user
    // and requires auth). Anonymous/login-screen stalls are out of scope here.
    if (!headers || !('Authorization' in headers)) return;
    await fetch(apiUrl('/api/debug/log'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(event),
      keepalive: true,
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Wraps a fetch implementation to time each call and report the slow/errored
 * ones. Returns a drop-in fetch with identical behavior (same Response, same
 * thrown errors) — measurement only, no timeout, no abort.
 */
export function createInstrumentedFetch(
  baseFetch: typeof fetch,
  surface: string,
): typeof fetch {
  return async function instrumentedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (isIngestionUrl(url)) return baseFetch(input as any, init);

    const t0 = Date.now();
    try {
      const resp = await baseFetch(input as any, init);
      const dt = Date.now() - t0;
      if (dt >= SLOW_THRESHOLD_MS || resp.status >= 500) {
        void postDebugLog({
          endpoint: `${surface}:${shortPath(url)}`,
          stage: 'client:response',
          durationMs: dt,
          status: resp.status,
        });
      }
      return resp;
    } catch (err) {
      const dt = Date.now() - t0;
      // A throw here is a network failure / stall killed by the OS — the most
      // important signal for the "spinner forever" report.
      void postDebugLog({
        endpoint: `${surface}:${shortPath(url)}`,
        stage: 'client:network_error',
        durationMs: dt,
        errorCode: err instanceof Error ? err.name : 'network_error',
      });
      throw err;
    }
  } as typeof fetch;
}
