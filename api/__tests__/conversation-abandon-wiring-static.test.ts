/**
 * Locks the server wiring of the abandon fail-safe against regression:
 *  - a heartbeat route + reconcile-on-start exist;
 *  - the balance computation and the sweep clamp consumption to the heartbeat;
 *  - an abandoned/force-closed session NEVER grants guided curricular credit
 *    (only the cooperative /session-complete path does).
 */
import { describe, it, expect } from 'vitest';

async function raw(path: string): Promise<string> {
  const src = await import(/* @vite-ignore */ `${path}?raw`);
  return (src as unknown as { default: string }).default;
}

describe('conversation abandon fail-safe — server wiring', () => {
  it('exposes a session-heartbeat route and closes prior open sessions when a new one starts', async () => {
    const code = await raw('../conversation/[...slug]');
    expect(code).toContain("case 'session-heartbeat': return handleSessionHeartbeat");
    // reconcile-on-start runs inside handleSession (before authorizing a new one):
    // it closes ALL of the user's own open rows so the balance, the session
    // ceiling, and the authorize RPC agree on the same real remaining.
    expect(code).toContain('closeUserOpenAuthorizationsForNewSession');
    const handleSession = code.slice(code.indexOf('async function handleSession('), code.indexOf('async function handleSessionComplete('));
    expect(handleSession).toContain('closeUserOpenAuthorizationsForNewSession');
    // the heartbeat only bumps the caller's OWN still-open row (ownership + status guarded)
    const heartbeat = code.slice(code.indexOf('async function handleSessionHeartbeat('));
    expect(heartbeat).toMatch(/last_seen_at/);
    expect(heartbeat).toMatch(/\.eq\('user_id', userId\)/);
    expect(heartbeat).toMatch(/\.eq\('status', 'authorized'\)/);
  });

  it('the shared accounting helper NEVER grants curricular credit for an abandoned session', async () => {
    const code = await raw('../conversation/_session-accounting');
    // Abandon/force-close must not record guided practice — that stays exclusive
    // to the cooperative /session-complete path.
    expect(code).not.toContain('recordCurricularPractice');
    // It DOES converge on the same accounting: quota mirror + reservation reconcile + extra-credits debit.
    expect(code).toContain('conversation_sessions');
    expect(code).toContain('settleConversationExtraCreditsDebit');
  });

  it('the balance computation clamps an open row to the last heartbeat + stale window', async () => {
    const code = await raw('../_entitlements/plan-entitlements-service');
    expect(code).toContain('AUTHORIZATION_HEARTBEAT_STALE_SECONDS');
    expect(code).toContain('last_seen_at');
  });

  it('the sweep closes heartbeat-stale authorizations via the shared helper (not only past-ceiling ones)', async () => {
    const code = await raw('../internal/listening/[...slug]');
    expect(code).toContain('isHeartbeatStale');
    expect(code).toContain('closeAuthorizationRow');
    expect(code).toContain('AUTHORIZATION_HEARTBEAT_STALE_SECONDS');
  });
});
