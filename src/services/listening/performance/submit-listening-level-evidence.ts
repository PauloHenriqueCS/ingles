import type { SupabaseClient } from '@supabase/supabase-js';

export async function submitListeningLevelEvidence(
  supabase: SupabaseClient,
  params: {
    userId: string;
    assignmentId: string;
    performanceScore: number;
  },
): Promise<void> {
  // Mark evidence as submitted in the results table.
  // Promotion engine integration for 'listening' skill is handled asynchronously
  // by the promotion service based on accumulated results.
  await supabase
    .from('user_listening_results')
    .update({ level_evidence_submitted: true, updated_at: new Date().toISOString() })
    .eq('user_id', params.userId)
    .eq('assignment_id', params.assignmentId);
}
