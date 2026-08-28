/**
 * CLIENT-SIDE latency diagnostics — INSTRUMENTATION ONLY (no behavior change).
 *
 * Purpose: for the reported 10-15s "spinner", the Supabase edge logs prove the
 * server answered the same requests in ~40-160ms — so the time is spent ON THE
 * DEVICE, before the request reaches Supabase. This module breaks that time down
 * so the NEXT incident can be attributed to an exact interval between two events,
 * WITHOUT guessing:
 *
 *   QUERY layer      → app calls supabase.from().select()  (not wrapped here)
 *   AUTH/session     → supabase.auth.getSession/getUser/refreshSession (+ lock)
 *   FETCH (SDK→net)  → the global fetch supabase-js calls (post-auth)
 *   NETWORK phases    → DNS / TCP / TLS / queue / TTFB / download (Resource Timing)
 *   SERVER            → already measured server-side (fast)
 *
 * It does NOT add retries, timeouts, aborts, lock changes, lib upgrades, query
 * refactors or any workaround. It only observes and reports.
 *
 * Safety: never logs access/refresh tokens, Authorization headers, cookies or
 * PII. URLs are sanitized (path only, query string dropped). The fetch wrapper
 * is a faithful pass-through — same Response, same thrown errors, never reads the
 * body. Reports are gated by the dashboard log level (dropped server-side when
 * off) and only sent for slow/notable events, throttled and capped.
 */

// ── tunables ──────────────────────────────────────────────────────────────────
const SLOW_FETCH_MS = 2_000;     // report a fetch at/above this
const SLOW_AUTH_MS = 1_000;      // report an auth op at/above this
const SLOW_RESOURCE_MS = 2_000;  // report a Resource-Timing entry at/above this
const MAX_POSTS_PER_SESSION = 200;
const MIN_POST_INTERVAL_MS = 150;

let postsSent = 0;
let lastPostAt = 0;

// ── correlation ───────────────────────────────────────────────────────────────
let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq}`;
}
/** All fetches/auth ops that fall in the same ~1.5s window share a batchId, so
 *  the 8 queries a screen fires on mount can be grouped after the fact. */
let currentBatchId = '';
let batchWindowUntil = 0;
function batchId(now: number): string {
  if (now > batchWindowUntil) {
    currentBatchId = nextId('batch');
    batchWindowUntil = now + 1_500;
  }
  return currentBatchId;
}

// ── url classification / sanitization ─────────────────────────────────────────
export type SupabaseCallType = 'rest' | 'auth' | 'functions' | 'realtime' | 'storage' | 'other';
export function classifySupabaseUrl(url: string): { type: SupabaseCallType; path: string; table?: string } {
  let path = url;
  try { path = new URL(url, 'http://x').pathname; } catch { path = String(url).split('?')[0]; }
  let type: SupabaseCallType = 'other';
  let table: string | undefined;
  if (path.startsWith('/rest/v1/')) {
    type = 'rest';
    const rest = path.slice('/rest/v1/'.length);
    table = rest.startsWith('rpc/') ? rest : rest.split('/')[0]; // table name only, no filters
  } else if (path.startsWith('/auth/v1/')) type = 'auth';
  else if (path.startsWith('/functions/v1/')) type = 'functions';
  else if (path.startsWith('/realtime/')) type = 'realtime';
  else if (path.startsWith('/storage/v1/')) type = 'storage';
  return { type, path: path.slice(0, 160), table };
}
function isSupabaseUrl(url: string): boolean {
  return /\/(rest|auth|functions|realtime|storage)\/v1\//.test(url);
}
function isOwnIngestionUrl(url: string): boolean {
  return url.includes('/api/debug/log');
}

// ── posting (reuses /api/debug/log; sanitized, gated server-side, throttled) ──
interface DiagEvent {
  endpoint: string;        // e.g. 'client:fetch', 'client:auth', 'client:net', 'client:resource'
  stage: string;           // e.g. 'fetch:slow', 'auth:getSession', 'net:offline', 'resource:phases'
  correlationId?: string;
  durationMs?: number;
  status?: number;
  errorCode?: string | null;
  detail?: Record<string, unknown>;
}
async function post(event: DiagEvent): Promise<void> {
  const now = Date.now();
  if (postsSent >= MAX_POSTS_PER_SESSION) return;
  if (now - lastPostAt < MIN_POST_INTERVAL_MS) return;
  postsSent += 1;
  lastPostAt = now;
  try {
    const [{ getAuthHeader }, { apiUrl }] = await Promise.all([import('./apiAuth'), import('./apiUrl')]);
    const headers = await getAuthHeader();
    if (!headers || !('Authorization' in headers)) return; // authed sessions only
    await fetch(apiUrl('/api/debug/log'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(event),
      keepalive: true,
    });
  } catch { /* best-effort */ }
}

// ── 1) enriched fetch wrapper (FETCH_START → FETCH_HEADERS_RECEIVED) ──────────
// Measures ONLY the fetch leg (this runs AFTER supabase-js resolved auth and
// attached the header — see fetchWithAuth in @supabase/supabase-js). So a slow
// time here means the delay is in the network/browser/WebView, NOT in auth.
export function createDiagnosticFetch(baseFetch: typeof fetch): typeof fetch {
  return async function diagnosticFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (isOwnIngestionUrl(url) || !isSupabaseUrl(url)) return baseFetch(input as any, init);

    const requestId = nextId('req');
    const { type, path, table } = classifySupabaseUrl(url);
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const wallStart = Date.now();
    const t0 = perfNow();
    const authInFlightAtStart = authInFlight; // was an auth op already running when this fetch began?

    try {
      const resp = await baseFetch(input as any, init);
      const dt = perfNow() - t0; // FETCH_START → FETCH_HEADERS_RECEIVED (body read later by the SDK)
      if (dt >= SLOW_FETCH_MS) {
        void post({
          endpoint: `client:fetch:${type}`,
          stage: 'fetch:headers_received',
          correlationId: requestId,
          durationMs: dt,
          status: resp.status,
          detail: {
            requestId, batchId: batchId(wallStart), type, table, method, path,
            fetchStartWall: wallStart,
            authInFlightAtStart,           // >0 ⇒ this fetch began while an auth op was running
            phase: 'sdk_fetch_to_headers',
          },
        });
      }
      return resp;
    } catch (err) {
      const dt = perfNow() - t0;
      const name = err instanceof Error ? err.name : 'unknown';
      const errorCode = name === 'AbortError' ? 'AbortError' : name === 'TypeError' ? 'TypeError' : 'network_error';
      void post({
        endpoint: `client:fetch:${type}`,
        stage: 'fetch:error',
        correlationId: requestId,
        durationMs: dt,
        errorCode,
        detail: { requestId, batchId: batchId(wallStart), type, table, method, path, fetchStartWall: wallStart, authInFlightAtStart },
      });
      throw err;
    }
  } as typeof fetch;
}

// ── 2) Resource Timing observer (DNS / TCP / TLS / queue / TTFB / download) ───
// Fires at responseEnd, so the FULL network breakdown is available. This is what
// pinpoints WHERE inside the network the seconds went. NOTE: cross-origin phase
// detail requires the Timing-Allow-Origin header on Supabase responses; when
// absent, DNS/TCP/TLS/TTFB come back 0 and only total/startTime are meaningful —
// still enough to confirm the browser itself recorded a multi-second resource.
function installResourceTimingObserver(): void {
  if (typeof PerformanceObserver === 'undefined') return;
  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const r = e as PerformanceResourceTiming;
        if (!r.name || !isSupabaseUrl(r.name) || isOwnIngestionUrl(r.name)) continue;
        const total = r.responseEnd - r.startTime;
        if (total < SLOW_RESOURCE_MS) continue;
        const { type, path, table } = classifySupabaseUrl(r.name);
        const phase = (a: number, b: number) => (a > 0 && b > 0 ? Math.round(b - a) : null);
        void post({
          endpoint: `client:resource:${type}`,
          stage: 'resource:phases',
          durationMs: Math.round(total),
          detail: {
            type, table, path,
            // Each phase in ms (null when the browser withheld cross-origin detail):
            queued_ms: Math.round(r.fetchStart - r.startTime),               // waiting for a connection slot
            dns_ms: phase(r.domainLookupStart, r.domainLookupEnd),
            tcp_ms: phase(r.connectStart, r.connectEnd),                     // includes TLS
            tls_ms: r.secureConnectionStart > 0 ? phase(r.secureConnectionStart, r.connectEnd) : null,
            ttfb_ms: phase(r.requestStart, r.responseStart),                 // waiting on the server (should be small)
            download_ms: phase(r.responseStart, r.responseEnd),
            total_ms: Math.round(total),
            transferSize: r.transferSize ?? null,
            nextHopProtocol: (r.nextHopProtocol || null),                    // h2 / http/1.1 — head-of-line hints
            startTimeWall: Math.round(performance.timeOrigin + r.startTime),
          },
        });
      }
    });
    obs.observe({ type: 'resource', buffered: true });
  } catch { /* observer unsupported */ }
}

// ── 3) auth / session instrumentation (getSession / getUser / refreshSession) ─
// Times the auth ops that every getCurrentUserId()/getAuthHeader() triggers and
// that share the supabase-js auth lock. A concurrency gauge (authInFlight) plus a
// max-observed-wait lets us see many queries piling up behind ONE slow auth op —
// the signature of an auth-lock stall (hypotheses 1-3). Wrappers call the
// originals and return their results UNCHANGED.
let authInFlight = 0;
type AnyFn = (...args: any[]) => Promise<any>;
function wrapAuthMethod(auth: any, name: string): void {
  const original = auth?.[name];
  if (typeof original !== 'function' || original.__diagWrapped) return;
  const wrapped: AnyFn = async function (this: unknown, ...args: any[]) {
    const opId = nextId('auth');
    const wall = Date.now();
    const t0 = perfNow();
    authInFlight += 1;
    const concurrentAtStart = authInFlight;
    try {
      return await original.apply(auth, args);
    } finally {
      const dt = perfNow() - t0;
      authInFlight -= 1;
      // getUser hits /auth/v1/user — capture WHO called it (sanitized stack) to
      // finish the audit of the 15 unexplained /auth/v1/user calls.
      const detail: Record<string, unknown> = {
        opId, method: name, wall, concurrentAtStart, authInFlightNow: authInFlight,
      };
      if (name === 'getUser') detail.caller = shortStack();
      if (dt >= SLOW_AUTH_MS || (name === 'getUser')) {
        void post({ endpoint: 'client:auth', stage: `auth:${name}`, correlationId: opId, durationMs: dt, detail });
      }
    }
  };
  (wrapped as any).__diagWrapped = true;
  auth[name] = wrapped;
}

/** A compact, PII-free stack tail (function names / file basenames only). */
function shortStack(): string {
  try {
    const raw = new Error().stack || '';
    return raw.split('\n').slice(2, 6)
      .map((l) => l.trim().replace(/https?:\/\/[^)\s]+\/([^/)\s]+)/g, '$1').replace(/\?[^)\s]*/g, ''))
      .join(' <- ').slice(0, 240);
  } catch { return ''; }
}

// ── 4) network state (online / offline / connection change) ──────────────────
function installNetworkListeners(): void {
  if (typeof window === 'undefined') return;
  const emit = (stage: string, detail: Record<string, unknown>) =>
    void post({ endpoint: 'client:net', stage, detail: { ...detail, onLine: navigatorOnLine() } });
  try {
    window.addEventListener('offline', () => emit('net:offline', { wall: Date.now() }));
    window.addEventListener('online', () => emit('net:online', { wall: Date.now() }));
    const conn = (navigator as any)?.connection;
    if (conn && typeof conn.addEventListener === 'function') {
      conn.addEventListener('change', () => emit('net:change', {
        wall: Date.now(), effectiveType: conn.effectiveType ?? null, rtt: conn.rtt ?? null, downlink: conn.downlink ?? null,
      }));
    }
  } catch { /* ignore */ }
}
function navigatorOnLine(): boolean | null {
  try { return typeof navigator !== 'undefined' ? navigator.onLine : null; } catch { return null; }
}

// ── perf.now fallback ─────────────────────────────────────────────────────────
function perfNow(): number {
  try { return typeof performance !== 'undefined' ? performance.now() : Date.now(); } catch { return Date.now(); }
}

// ── init (call once, after the supabase client is created) ───────────────────
let initialized = false;
export function initClientDiagnostics(supabase: { auth: any }): void {
  if (initialized) return;
  initialized = true;
  try {
    wrapAuthMethod(supabase.auth, 'getSession');
    wrapAuthMethod(supabase.auth, 'getUser');
    wrapAuthMethod(supabase.auth, 'refreshSession');
    // Observe auth state transitions (TOKEN_REFRESHED / SIGNED_IN / SIGNED_OUT …).
    if (typeof supabase.auth.onAuthStateChange === 'function') {
      supabase.auth.onAuthStateChange((event: string) => {
        void post({ endpoint: 'client:auth', stage: 'auth:state_change', detail: { event, wall: Date.now(), authInFlightNow: authInFlight } });
      });
    }
  } catch { /* ignore */ }
  installResourceTimingObserver();
  installNetworkListeners();
}
