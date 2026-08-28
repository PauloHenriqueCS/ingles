import { createClient } from '@supabase/supabase-js';
import { createInstrumentedFetch } from './debugLog';

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
    // Measure every PostgREST/Auth call and report only the slow/stalled ones
    // (see debugLog.ts). Behaviour is otherwise identical to the default fetch —
    // no timeout, no abort. Reports are dropped server-side unless the dashboard
    // log level is on, so this is a no-op in normal operation.
    fetch: createInstrumentedFetch(
      (input, init) => fetch(input as RequestInfo | URL, init),
      'supabase',
    ),
  },
});
