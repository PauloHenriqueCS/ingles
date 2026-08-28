import { createClient } from '@supabase/supabase-js';
import { createDiagnosticFetch, initClientDiagnostics } from './clientDiagnostics';

const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = createClient(url, key, {
  auth: {
    flowType: 'pkce',
    detectSessionInUrl: true,
    persistSession: true,
    autoRefreshToken: true,
  },
  global: {
    // INSTRUMENTATION ONLY (see clientDiagnostics.ts): times the fetch leg that
    // supabase-js calls AFTER it resolves the session, so a slow time here points
    // at network/browser, not auth. Faithful pass-through — no timeout, no abort,
    // never reads the body. Reports are dropped server-side unless the dashboard
    // log level is on, so this is a no-op in normal operation.
    fetch: createDiagnosticFetch(
      (input, init) => fetch(input as RequestInfo | URL, init),
    ),
  },
});

// Instrument auth/session (getSession/getUser/refreshSession + state changes),
// the Resource-Timing network breakdown, and online/offline events — so a future
// 10-15s stall can be attributed to an exact interval. Observe-only.
initClientDiagnostics(supabase);
