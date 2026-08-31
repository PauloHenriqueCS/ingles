import { supabase } from './supabase';
import { getCurrentUserId } from './authSession';

/**
 * Per-user, SERVER-side persistence for the "Rotina de estudos" onboarding — the
 * MANDATORY first-access step (choose practice days + plan practices) shown AFTER
 * the Home tutorial and before the Home is released. Mirrors the direct-Supabase,
 * per-user pattern used by tutorialProgress.ts / practiceReminder.ts /
 * learningSettings.ts against a dedicated table (user_study_routine_config) with
 * RLS `auth.uid() = user_id`. One row per user (user_id is the PK), written via
 * upsert onConflict: 'user_id'.
 *
 * IMPORTANT: this table stores ONLY the completion flag. The actual values live
 * in their existing sources of truth — days in user_learning_settings, practices
 * in user_curriculum_preferences — so there is never a second source of truth.
 *
 * SEMÂNTICA: two clear situations.
 *   - 'unconfigured' → never completed the initial config → the gate must show it.
 *                      For a NEW user this is the ABSENCE of a row, which
 *                      fetchStudyRoutineStatus() maps to 'unconfigured'.
 *   - 'configured'   → completed the mandatory step (stamps configured_at).
 *
 * NEVER localStorage as the source of truth — this must survive reinstall,
 * logout/login and use on another device (see usePlacementStatus / tutorialProgress).
 */

export type StudyRoutineStatus = 'unconfigured' | 'configured';

const TABLE = 'user_study_routine_config';

/**
 * Reads the current server status. Returns 'unconfigured' when the user has no
 * row yet (a new account — they must configure). Returns null ONLY when the
 * status is genuinely unknown (not authenticated / backend error) so the caller
 * can fail safe and NEVER trap the user behind the gate on a transient failure —
 * the gate re-checks and re-appears on the next launch while still unconfigured.
 */
export async function fetchStudyRoutineStatus(): Promise<StudyRoutineStatus | null> {
  const uid = await getCurrentUserId();
  if (!uid) return null;

  const { data, error } = await supabase
    .from(TABLE)
    .select('status')
    .eq('user_id', uid)
    .maybeSingle();

  // A backend error is "unknown" → null (fail safe: never block on transient error).
  if (error) return null;
  // No row → brand-new user → must configure.
  if (!data) return 'unconfigured';

  const status = (data as { status?: string }).status;
  if (status === 'configured' || status === 'unconfigured') {
    return status;
  }
  // Any unexpected value is treated as "already configured" to avoid re-trapping.
  return 'configured';
}

/** Persists that the user finished the mandatory config (idempotent upsert). */
export async function markStudyRoutineConfigured(): Promise<void> {
  const uid = await getCurrentUserId();
  if (!uid) throw new Error('Não autenticado');

  const { error } = await supabase.from(TABLE).upsert(
    {
      user_id: uid,
      status: 'configured',
      configured_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );
  if (error) throw new Error(error.message);
}
