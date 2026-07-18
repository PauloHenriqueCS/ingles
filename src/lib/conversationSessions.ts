import { supabase } from './supabase';

/**
 * The single source of truth for "was today's conversation goal met" —
 * used by the calendar, the daily goal card, and the in-session progress
 * bar. Never recompute this comparison ad-hoc in a component.
 */
export function isConversationGoalMet(totalSeconds: number, goalMinutes: number): boolean {
  return totalSeconds >= goalMinutes * 60;
}

export async function recordConversationSession(date: string, durationSec: number): Promise<void> {
  if (durationSec < 10) return;
  const { error } = await supabase.from('conversation_sessions').insert({ session_date: date, duration_sec: durationSec });
  if (error) console.error('[conversation] failed to save session', { date, durationSec, error: error.message });
}

export async function getDayTotalSeconds(date: string): Promise<number> {
  const { data } = await supabase
    .from('conversation_sessions')
    .select('duration_sec')
    .eq('session_date', date);
  return (data ?? []).reduce((sum, row) => sum + (row.duration_sec as number), 0);
}

export async function getConversationGoalMinutes(): Promise<number> {
  const { data } = await supabase
    .from('ai_conversation_preferences')
    .select('daily_conversation_goal_minutes')
    .maybeSingle();
  return (data?.daily_conversation_goal_minutes as number | null) ?? 15;
}

export async function getMonthSessionTotals(year: number, month: number): Promise<Record<string, number>> {
  const pad = (n: number) => String(n).padStart(2, '0');
  const start = `${year}-${pad(month)}-01`;
  const end = new Date(year, month, 0).toISOString().split('T')[0];
  const { data } = await supabase
    .from('conversation_sessions')
    .select('session_date, duration_sec')
    .gte('session_date', start)
    .lte('session_date', end);
  const totals: Record<string, number> = {};
  for (const row of data ?? []) {
    const d = row.session_date as string;
    totals[d] = (totals[d] ?? 0) + (row.duration_sec as number);
  }
  return totals;
}
