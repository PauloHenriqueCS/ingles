import type { SupabaseClient } from '@supabase/supabase-js';
import type { GenerationStatusResult } from './listening-on-demand-types';
import { toPublicSessionResult, OnDemandSessionNotFoundError } from './listening-on-demand-types';

export async function getListeningGenerationStatus(
  sessionId: string,
  userId: string,
  serviceClient: SupabaseClient,
): Promise<GenerationStatusResult> {
  const { data: session, error } = await serviceClient
    .from('user_listening_generation_sessions')
    .select('id, status, current_step, progress_percent, episode_id, error_code, error_message, retryable')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !session) {
    throw new OnDemandSessionNotFoundError(sessionId);
  }

  return toPublicSessionResult(session as any);
}

export async function findTodayGenerationSession(
  userId: string,
  localDate: string,
  serviceClient: SupabaseClient,
): Promise<GenerationStatusResult | null> {
  const { data: session } = await serviceClient
    .from('user_listening_generation_sessions')
    .select('id, status, current_step, progress_percent, episode_id, error_code, error_message, retryable')
    .eq('user_id', userId)
    .eq('local_date', localDate)
    .not('status', 'in', '("cancelled")')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!session) return null;
  return toPublicSessionResult(session as any);
}
