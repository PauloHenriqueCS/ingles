import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAnonCredentials } from './_env';
import { isAccountDeactivated } from './_account/deactivation-status';

function createAuthedSupabase(token: string): SupabaseClient {
  const { url, key } = getSupabaseAnonCredentials();
  return createClient(url, key, { global: { headers: { Authorization: `Bearer ${token}` } } });
}

export interface AuthedContext {
  userId: string;
  supabase: SupabaseClient;
  /** The caller's own raw access token — needed by the handful of routes
   *  (account deactivation) that must act on the caller's own Supabase Auth
   *  session via the admin API (e.g. admin.signOut(token, 'global')). */
  accessToken: string;
}

export interface RequireAuthOptions {
  /** Bypasses the account-deactivation gate below. Reserved for the
   *  deactivation route itself, which must stay reachable — and idempotent
   *  — even after the account is already deactivated. Every other route
   *  must leave this unset so a deactivated account is blocked everywhere. */
  allowDeactivated?: boolean;
}

export async function requireAuth(req: any, res: any, options?: RequireAuthOptions): Promise<AuthedContext | null> {
  const token = (req.headers['authorization'] as string | undefined)?.replace('Bearer ', '').trim();
  if (!token) {
    res.status(401).json({ error: 'Não autenticado' });
    return null;
  }
  const supabase = createAuthedSupabase(token);
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    res.status(401).json({ error: 'Sessão inválida ou expirada' });
    return null;
  }

  if (!options?.allowDeactivated && await isAccountDeactivated(user.id)) {
    res.status(403).json({ code: 'ACCOUNT_DEACTIVATED', message: 'Esta conta não está disponível.' });
    return null;
  }

  return { userId: user.id, supabase, accessToken: token };
}
