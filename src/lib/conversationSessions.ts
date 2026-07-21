import { supabase } from './supabase';
import { getAuthHeader } from './apiAuth';

/**
 * The single source of truth for "was today's conversation goal met" —
 * used by the calendar, the daily goal card, and the in-session progress
 * bar. Never recompute this comparison ad-hoc in a component.
 */
export function isConversationGoalMet(totalSeconds: number, goalMinutes: number): boolean {
  return totalSeconds >= goalMinutes * 60;
}

/**
 * Closes the server-side authorization opened by /api/conversation/session
 * (see recordingAuthorizationId in useRealtimeSession.ts) — this is what
 * actually writes the completed conversation_sessions row, with a duration
 * computed server-side from authorized_at, never client-supplied. Direct
 * client INSERT into conversation_sessions is blocked by RLS as of
 * 20260721010000_conversation_session_server_authoritative.sql: a raw
 * insert here previously let a student report an arbitrary (understated)
 * duration for a real, already-costly conversation, bypassing the plan's
 * monthly quota (plan-entitlements-service.ts sums that table). Best-effort:
 * a failure just means this call's time doesn't land in the calendar/quota
 * this time — never surfaced to the student, never retried destructively.
 */
export async function completeConversationSession(recordingAuthorizationId: string): Promise<void> {
  try {
    const headers = await getAuthHeader();
    await fetch('/api/conversation/session-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ recordingAuthorizationId }),
    });
  } catch (error) {
    console.error('[conversation] failed to complete session', { recordingAuthorizationId, error });
  }
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
