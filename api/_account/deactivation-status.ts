/**
 * SERVER-ONLY: cheap read used by the central auth guard (api/_auth.ts) on
 * every authenticated request to every gateway route.
 *
 * Fails OPEN (treats the account as active) on any error — including a
 * missing user_account_deactivations relation, i.e. this migration not yet
 * applied. Same philosophy as api/_rateLimit.ts's checkRateLimitRaw: a
 * feature that hasn't been rolled out to the database yet must never take
 * down every existing route. Once the migration is applied this starts
 * enforcing automatically, with no code change.
 */

import { getSharedServiceClient } from '../_ai-gateway/usage-repository';

export async function isAccountDeactivated(userId: string): Promise<boolean> {
  try {
    const supabase = getSharedServiceClient();
    const { data, error } = await supabase
      .from('user_account_deactivations')
      .select('id')
      .eq('user_id', userId)
      .eq('status', 'deactivated')
      .limit(1)
      .maybeSingle();
    if (error) return false;
    return data != null;
  } catch {
    return false;
  }
}
