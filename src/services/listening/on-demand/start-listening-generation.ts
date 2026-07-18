import type { SupabaseClient } from '@supabase/supabase-js';
import type { StartGenerationResult, GenerationSessionStatus } from './listening-on-demand-types';
import { STEP_LABELS, STEP_PROGRESS } from './listening-on-demand-types';

function sessionToStartResult(session: {
  id: string;
  status: string;
  current_step: string | null;
  progress_percent: number;
  episode_id: string | null;
}): StartGenerationResult {
  const status = session.status as GenerationSessionStatus;
  return {
    generationSessionId: session.id,
    status,
    currentStep: session.current_step ?? STEP_LABELS[status] ?? null,
    progressPercent: session.progress_percent,
    episodeId: session.episode_id,
  };
}

export async function startListeningGeneration(
  userId: string,
  serviceClient: SupabaseClient,
  localDate: string,
): Promise<StartGenerationResult> {
  const idempotencyKey = `listening-on-demand:${userId}:${localDate}`;

  // 1. Check for existing active session today
  const { data: existing } = await serviceClient
    .from('user_listening_generation_sessions')
    .select('id, status, current_step, progress_percent, episode_id')
    .eq('user_id', userId)
    .eq('local_date', localDate)
    .not('status', 'in', '("cancelled","failed")')
    .maybeSingle();

  if (existing) {
    return sessionToStartResult(existing);
  }

  // 2. Check if there's already a published episode assigned to the user today.
  // Multi-story plans can have several rows for the same day; prefer the
  // active one, else fall back to the most recently created.
  const { data: todaysAssignments } = await serviceClient
    .from('user_listening_assignments')
    .select('episode_id, status, created_at')
    .eq('user_id', userId)
    .eq('activity_date', localDate)
    .not('episode_id', 'is', null)
    .order('created_at', { ascending: false });

  const assignmentRows = todaysAssignments ?? [];
  const assignment = assignmentRows.find((row: any) => row.status !== 'completed') ?? assignmentRows[0] ?? null;

  if (assignment?.episode_id) {
    // Verify episode is published
    const { data: episode } = await serviceClient
      .from('listening_episodes')
      .select('id, status')
      .eq('id', assignment.episode_id)
      .eq('status', 'published')
      .maybeSingle();

    if (episode) {
      // Create a "ready" session to represent the existing episode
      const { data: readySession, error: insertErr } = await serviceClient
        .from('user_listening_generation_sessions')
        .insert({
          user_id: userId,
          local_date: localDate,
          idempotency_key: idempotencyKey,
          status: 'ready',
          progress_percent: 100,
          episode_id: episode.id,
          current_step: STEP_LABELS['ready'],
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
        })
        .select('id, status, current_step, progress_percent, episode_id')
        .single();

      if (insertErr || !readySession) {
        // Session might have been created concurrently - fetch it
        const { data: concurrentSession } = await serviceClient
          .from('user_listening_generation_sessions')
          .select('id, status, current_step, progress_percent, episode_id')
          .eq('idempotency_key', idempotencyKey)
          .maybeSingle();
        if (concurrentSession) return sessionToStartResult(concurrentSession);
      }

      if (readySession) return sessionToStartResult(readySession);
    }
  }

  // 3. Create new session starting at identifying_level
  const initialStatus: GenerationSessionStatus = 'identifying_level';
  const { data: newSession, error: createErr } = await serviceClient
    .from('user_listening_generation_sessions')
    .insert({
      user_id: userId,
      local_date: localDate,
      idempotency_key: idempotencyKey,
      status: initialStatus,
      progress_percent: STEP_PROGRESS[initialStatus],
      current_step: STEP_LABELS[initialStatus],
      started_at: new Date().toISOString(),
    })
    .select('id, status, current_step, progress_percent, episode_id')
    .single();

  if (createErr || !newSession) {
    // Handle race condition: another request created the session
    const { data: raceSession } = await serviceClient
      .from('user_listening_generation_sessions')
      .select('id, status, current_step, progress_percent, episode_id')
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();
    if (raceSession) return sessionToStartResult(raceSession);
    throw new Error(`Failed to create generation session: ${createErr?.message ?? 'no data returned'}`);
  }

  return sessionToStartResult(newSession);
}
