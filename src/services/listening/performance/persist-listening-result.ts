import type { SupabaseClient } from '@supabase/supabase-js';
import type { PerformanceCalculation } from './listening-performance-types';

export async function persistListeningResult(
  supabase: SupabaseClient,
  params: {
    userId: string;
    assignmentId: string;
    episodeId: string;
    calc: PerformanceCalculation;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await supabase
    .from('user_listening_results')
    .upsert(
      {
        user_id:              params.userId,
        assignment_id:        params.assignmentId,
        episode_id:           params.episodeId,
        performance_score:    params.calc.performanceScore,
        q1_attempt_cycle:     params.calc.q1AttemptCycle,
        q2_attempt_cycle:     params.calc.q2AttemptCycle,
        q1_weight:            params.calc.q1Weight,
        q2_weight:            params.calc.q2Weight,
        calculation_version:  params.calc.calculationVersion,
        level_evidence_submitted: false,
        calculated_at:        now,
        updated_at:           now,
      },
      { onConflict: 'user_id,assignment_id' },
    );
}
