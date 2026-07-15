import type { SupabaseClient } from '@supabase/supabase-js';

export async function expireListeningSessions(
  serviceClient: SupabaseClient,
  userId: string,
  blockId: string,
): Promise<void> {
  await serviceClient
    .from('user_listening_block_sessions')
    .update({ status: 'expired', updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('block_id', blockId)
    .in('status', ['active', 'awaiting_answer', 'replay_required'])
    .lt('expires_at', new Date().toISOString());
}
