import { supabase } from './supabase';
import { getCurrentUserId } from './authSession';
import {
  DEFAULT_PRACTICE_REMINDER,
  normalizePreference,
  type PracticeReminderPreference,
} from '../domain/practiceReminder/practiceReminder';

/**
 * Per-user persistence for the Practice Reminder preference — the SERVER-side
 * "desired configuration" (fonte da verdade). It mirrors the direct-Supabase,
 * per-user pattern used by audioSettings.ts / learningSettings.ts, but against
 * a dedicated table (user_practice_reminder_preferences) with typed columns and
 * RLS `auth.uid() = user_id`. One row per user (user_id is the PK), written via
 * upsert onConflict: 'user_id'.
 *
 * This module only PERSISTS intent. The actual device scheduling lives in
 * src/lib/notifications/practiceReminderService.ts — kept separate on purpose
 * (§17): persistence, native scheduling, sync and UI are distinct layers.
 */

const TABLE = 'user_practice_reminder_preferences';

export async function fetchPracticeReminder(): Promise<PracticeReminderPreference> {
  const uid = await getCurrentUserId();
  if (!uid) return { ...DEFAULT_PRACTICE_REMINDER };

  const { data, error } = await supabase
    .from(TABLE)
    .select('enabled, weekdays, hour, minute')
    .eq('user_id', uid)
    .maybeSingle();

  if (error || !data) return { ...DEFAULT_PRACTICE_REMINDER };
  return normalizePreference(data as Partial<PracticeReminderPreference>);
}

export async function savePracticeReminder(
  pref: PracticeReminderPreference,
): Promise<PracticeReminderPreference> {
  const uid = await getCurrentUserId();
  if (!uid) throw new Error('Não autenticado');

  const normalized = normalizePreference(pref);
  const { error } = await supabase.from(TABLE).upsert(
    {
      user_id: uid,
      enabled: normalized.enabled,
      weekdays: normalized.weekdays,
      hour: normalized.hour,
      minute: normalized.minute,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );

  if (error) throw new Error(error.message);
  return normalized;
}
