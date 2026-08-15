/**
 * Unit tests for SupabaseConcurrencyLimiter — the thin TS wrapper over the
 * acquire/release_gateway_concurrency_slot_v1 RPCs. The atomic cross-instance
 * guarantee itself is a SQL property (advisory lock + count-then-insert),
 * validated against a live database in
 * supabase/manual-validation/ai-gateway-concurrency-slots.sql; here we prove
 * the wrapper maps arguments/results correctly and NEVER swallows an infra
 * error into a silent "allow".
 */

import { describe, it, expect, vi } from 'vitest';
import { SupabaseConcurrencyLimiter } from '../_ai-gateway/concurrency-limiter';

function clientReturning(result: { data?: unknown; error?: unknown }) {
  const rpc = vi.fn().mockResolvedValue({ data: null, error: null, ...result });
  return { client: { rpc } as any, rpc };
}

describe('SupabaseConcurrencyLimiter.acquire', () => {
  it('maps a granted slot from the RPC row', async () => {
    const { client, rpc } = clientReturning({ data: [{ slot_id: 'slot-9', acquired: true, active_count: 3 }] });
    const limiter = new SupabaseConcurrencyLimiter(client);

    const r = await limiter.acquire('u:abc|global', 'abc', 'writing.correct', 'openai', 8, 180);

    expect(r).toEqual({ acquired: true, slotId: 'slot-9', activeCount: 3 });
    expect(rpc).toHaveBeenCalledWith('acquire_gateway_concurrency_slot_v1', {
      p_scope_key: 'u:abc|global', p_user_id: 'abc', p_feature_key: 'writing.correct',
      p_provider: 'openai', p_max_concurrent: 8, p_lease_seconds: 180,
    });
  });

  it('maps a denied result (at ceiling) without inventing a slot', async () => {
    const { client } = clientReturning({ data: [{ slot_id: null, acquired: false, active_count: 8 }] });
    const limiter = new SupabaseConcurrencyLimiter(client);
    const r = await limiter.acquire('u:abc|global', 'abc', 'writing.correct', 'openai', 8, 180);
    expect(r).toEqual({ acquired: false, slotId: null, activeCount: 8 });
  });

  it('THROWS on an RPC error (never a silent allow) so the caller can fail closed', async () => {
    const { client } = clientReturning({ data: null, error: { message: 'db down' } });
    const limiter = new SupabaseConcurrencyLimiter(client);
    await expect(limiter.acquire('u:abc|global', 'abc', 'writing.correct', 'openai', 8, 180))
      .rejects.toThrow(/acquire_gateway_concurrency_slot_v1 failed: db down/);
  });

  it('truncates an over-long scope key to the RPC/column limit (200)', async () => {
    const { client, rpc } = clientReturning({ data: [{ slot_id: 's', acquired: true, active_count: 1 }] });
    const limiter = new SupabaseConcurrencyLimiter(client);
    await limiter.acquire('u:' + 'x'.repeat(500), 'abc', 'writing.correct', 'openai', 8, 180);
    const passed = rpc.mock.calls[0][1].p_scope_key as string;
    expect(passed.length).toBe(200);
  });
});

describe('SupabaseConcurrencyLimiter.release', () => {
  it('calls the release RPC with slot id + reason', async () => {
    const { client, rpc } = clientReturning({ data: null });
    const limiter = new SupabaseConcurrencyLimiter(client);
    await limiter.release('slot-9', 'completed');
    expect(rpc).toHaveBeenCalledWith('release_gateway_concurrency_slot_v1', { p_slot_id: 'slot-9', p_reason: 'completed' });
  });

  it('THROWS on a release RPC error (surfaced, never hidden)', async () => {
    const { client } = clientReturning({ data: null, error: { message: 'nope' } });
    const limiter = new SupabaseConcurrencyLimiter(client);
    await expect(limiter.release('slot-9', 'completed')).rejects.toThrow(/release_gateway_concurrency_slot_v1 failed: nope/);
  });
});
