import { supabase } from './supabase';
import { getCurrentUserId } from './authSession';

/**
 * Per-user, SERVER-side persistence for the first-run Home tutorial (walkthrough)
 * status. Mirrors the direct-Supabase, per-user pattern used by
 * practiceReminder.ts / audioSettings.ts / learningSettings.ts against a
 * dedicated table (user_tutorial_progress) with RLS `auth.uid() = user_id`. One
 * row per user (user_id is the PK), written via upsert onConflict: 'user_id'.
 *
 * SEMÂNTICA (§8): three clear situations.
 *   - 'pending'    → never completed nor skipped → the tutorial should show. For
 *                    a NEW user this is represented by the ABSENCE of a row, which
 *                    fetchTutorialStatus() maps to 'pending'.
 *   - 'completed'  → finished the last step (stamps completed_at).
 *   - 'skipped'    → tapped "Pular tutorial" on any step (stamps skipped_at).
 *
 * NEVER localStorage as the source of truth — the codebase persists these
 * per-user states on the server (see usePlacementStatus / practiceReminder).
 */

export type TutorialStatus = 'pending' | 'completed' | 'skipped';

const TABLE = 'user_tutorial_progress';

/**
 * Reads the current server status. Returns 'pending' when the user has no row
 * yet (a new account — they should see the tutorial). Returns null ONLY when the
 * status is genuinely unknown (not authenticated / backend error) so the caller
 * can fail safe and NEVER auto-show the tutorial on a transient failure.
 */
export async function fetchTutorialStatus(): Promise<TutorialStatus | null> {
  const uid = await getCurrentUserId();
  if (!uid) return null;

  const { data, error } = await supabase
    .from(TABLE)
    .select('status')
    .eq('user_id', uid)
    .maybeSingle();

  // A backend error is "unknown" → null (fail safe: do not force the tutorial).
  if (error) return null;
  // No row → brand-new user → pending (should see the tutorial).
  if (!data) return 'pending';

  const status = (data as { status?: string }).status;
  if (status === 'completed' || status === 'skipped' || status === 'pending') {
    return status;
  }
  // Any unexpected value is treated as "already settled" to avoid re-showing.
  return 'completed';
}

/** Persists that the user finished the tutorial (idempotent upsert). */
export async function markTutorialCompleted(): Promise<void> {
  const uid = await getCurrentUserId();
  if (!uid) throw new Error('Não autenticado');

  const { error } = await supabase.from(TABLE).upsert(
    {
      user_id: uid,
      status: 'completed',
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );
  if (error) throw new Error(error.message);
}

/** Persists that the user skipped the tutorial (idempotent upsert). */
export async function markTutorialSkipped(): Promise<void> {
  const uid = await getCurrentUserId();
  if (!uid) throw new Error('Não autenticado');

  const { error } = await supabase.from(TABLE).upsert(
    {
      user_id: uid,
      status: 'skipped',
      skipped_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );
  if (error) throw new Error(error.message);
}
