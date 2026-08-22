import { supabase } from './supabase';

/**
 * Returns the current user's id from the LOCALLY persisted Supabase session,
 * WITHOUT a `/auth/v1/user` (GoTrue) network round-trip.
 *
 * Why this is safe: the id is used only to build `.eq('user_id', id)` filters
 * on RLS-protected tables. Row ownership is enforced server-side by Postgres
 * RLS (`user_id = auth.uid()`, evaluated from the verified JWT) and by the API
 * routes' server-side `requireAuth` (api/_auth.ts) — never by this
 * client-supplied id. A stale/forged local session would have its JWT rejected
 * by PostgREST, so this can only ever fail closed (no rows), never leak another
 * user's data.
 *
 * `getSession()` reads the in-memory/stored session; it performs a network call
 * only to refresh an EXPIRED access token (`/auth/v1/token`) — the necessary,
 * already-existing auto-refresh — never `/auth/v1/user`.
 */
export async function getCurrentUserId(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.user?.id ?? null;
}
