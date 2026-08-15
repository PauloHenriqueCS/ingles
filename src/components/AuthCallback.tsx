import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

/**
 * Post-login landing at /auth/callback. Originally written for the password
 * PKCE `?code=` case, which broke Google OAuth: this project runs Supabase's
 * default *implicit* flow, so signInWithOAuth returns to /auth/callback with the
 * session in the URL *hash* (#access_token=…), not `?code=`. detectSessionInUrl
 * establishes the session asynchronously; the old code only read `?code=` from
 * the query string, found nothing, and rendered "Link de acesso inválido" even
 * though the session was (about to be) valid.
 *
 * This version is flow-agnostic and never navigates until a session actually
 * exists: real provider errors (query OR hash) surface as errors; an existing
 * session goes Home; a `?code=` is exchanged (PKCE fallback); otherwise it waits
 * for detectSessionInUrl to finish (with a timeout backstop) instead of guessing.
 */

const SESSION_WAIT_TIMEOUT_MS = 8000;

export type CallbackDecision =
  | { kind: 'error'; message: string }
  | { kind: 'exchange'; code: string }
  | { kind: 'wait' }
  | { kind: 'done' };

/** Pure decision so the branching is unit-testable without a browser. */
export function decideCallback(input: {
  search: string;
  hash: string;
  hasSession: boolean;
}): CallbackDecision {
  const q = new URLSearchParams(input.search);
  const h = new URLSearchParams(input.hash.replace(/^#/, ''));
  const err =
    q.get('error_description') ||
    h.get('error_description') ||
    q.get('error') ||
    h.get('error');
  if (err) return { kind: 'error', message: err };
  if (input.hasSession) return { kind: 'done' };
  const code = q.get('code');
  if (code) return { kind: 'exchange', code };
  return { kind: 'wait' };
}

export default function AuthCallback() {
  const [error, setError] = useState('');

  useEffect(() => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    let timer: number | undefined;

    const goHome = () => {
      if (settled) return;
      settled = true;
      window.location.replace('/');
    };
    const fail = (raw: string) => {
      if (settled) return;
      settled = true;
      setError(translateCallbackError(raw));
    };

    async function run() {
      const { data } = await supabase.auth.getSession();
      const decision = decideCallback({
        search: window.location.search,
        hash: window.location.hash,
        hasSession: Boolean(data.session),
      });

      if (decision.kind === 'done') return goHome();
      if (decision.kind === 'error') return fail(decision.message);
      if (decision.kind === 'exchange') {
        const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(decision.code);
        if (exchangeError) return fail(exchangeError.message);
        return goHome();
      }

      // 'wait': implicit flow — detectSessionInUrl parses the hash asynchronously.
      // Navigate the moment a session appears; only fail if none arrives in time.
      const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
        if (session) goHome();
      });
      unsubscribe = () => sub.subscription.unsubscribe();
      timer = window.setTimeout(async () => {
        const { data: retry } = await supabase.auth.getSession();
        if (retry.session) goHome();
        else fail('session_not_established');
      }, SESSION_WAIT_TIMEOUT_MS);
    }

    void run();

    return () => {
      settled = true;
      unsubscribe?.();
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  if (error) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
        <div className="text-center space-y-3">
          <p className="text-red-400 text-sm">{error}</p>
          <a
            href="/"
            className="text-xs text-slate-400 hover:text-slate-200 transition-colors"
          >
            Voltar ao início
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center">
      <div className="text-center space-y-3">
        <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="text-slate-400 text-sm">Entrando...</p>
      </div>
    </div>
  );
}

function translateCallbackError(raw: string): string {
  if (/access_denied|cancell?ed|cancelou/i.test(raw)) return 'Login cancelado. Tente novamente.';
  if (/expired|otp_expired/i.test(raw)) return 'Este link expirou. Tente entrar novamente.';
  return 'Não foi possível concluir o login. Tente novamente.';
}
