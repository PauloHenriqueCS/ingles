import type { SupabaseClient } from '@supabase/supabase-js';
import type { ListeningAssignmentStatus } from './listening-daily-types';

export async function updateListeningAssignmentStatus(
  supabase: SupabaseClient,
  assignmentId: string,
  status: ListeningAssignmentStatus,
): Promise<void> {
  const now = new Date().toISOString();
  const updates: Record<string, unknown> = { status, updated_at: now };
  if (status === 'in_progress') updates.started_at = now;
  if (status === 'completed')   updates.completed_at = now;

  await supabase
    .from('user_listening_assignments')
    .update(updates)
    .eq('id', assignmentId);
}
