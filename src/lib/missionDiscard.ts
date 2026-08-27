import { getAuthHeader } from './apiAuth';
import { apiUrl } from './apiUrl';

/**
 * Supersedes the day's currently-active mission server-side (marks it
 * 'regenerated'), so a subsequent restore (`mode: 'retrieve'`) returns nothing
 * and "Nova missão" truly starts from a clean slate. Best-effort and idempotent:
 * it makes no AI call, consumes no generation, and never blocks the reset — a
 * failure just leaves the old mission restorable, never corrupts state.
 */
export async function discardCurrentMission(): Promise<void> {
  try {
    const authHeader = await getAuthHeader();
    await fetch(apiUrl('/api/generate-theme'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify({ mode: 'discard' }),
    });
  } catch {
    // best-effort — the local reset already happened; never surface an error
  }
}
