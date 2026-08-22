import { useState, useEffect } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

export interface AuthState {
  user: User | null;
  session: Session | null;
  userId: string | null;
  loading: boolean;
}

/**
 * Single source of truth for the frontend auth state.
 *
 * Boot reads the LOCAL session (`getSession()`) instead of `getUser()`, so app
 * startup no longer makes a `/auth/v1/user` (GoTrue) round-trip just to learn
 * who the user is — the session was already restored from storage by
 * supabase-js. `onAuthStateChange` keeps `user`/`session` fresh on sign-in,
 * sign-out and token refresh, so no polling of the Auth server is needed during
 * normal use.
 *
 * Security is unchanged: this state only drives what the UI renders. Every real
 * data access is authorized server-side — Postgres RLS from the verified JWT,
 * and the API routes' server-side `requireAuth` (api/_auth.ts).
 */
export function useAuth(): AuthState {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    // `.finally` guarantees the boot spinner is always released — even if the
    // local session read throws — so a transient Auth/storage error can never
    // strand the app on the "Carregando..." gate.
    supabase.auth.getSession()
      .then(({ data }) => {
        if (cancelled) return;
        setSession(data.session ?? null);
        setUser(data.session?.user ?? null);
      })
      .catch(() => { /* no usable session → treated as logged-out below */ })
      .finally(() => { if (!cancelled) setLoading(false); });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession ?? null);
      setUser(nextSession?.user ?? null);
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  return { user, session, userId: user?.id ?? null, loading };
}
