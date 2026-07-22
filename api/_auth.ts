import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAnonCredentials } from './_env';

function createAuthedSupabase(token: string): SupabaseClient {
  const { url, key } = getSupabaseAnonCredentials();
  return createClient(url, key, { global: { headers: { Authorization: `Bearer ${token}` } } });
}

export interface AuthedContext {
  userId: string;
  supabase: SupabaseClient;
}

export async function requireAuth(req: any, res: any): Promise<AuthedContext | null> {
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
  return { userId: user.id, supabase };
}
