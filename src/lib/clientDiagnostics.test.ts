import { describe, it, expect, vi } from 'vitest';
import { createDiagnosticFetch, classifySupabaseUrl } from './clientDiagnostics';

// Non-supabase URLs skip the wrapper's report path entirely, so these tests
// assert the pass-through contract with zero side effects.
const OTHER = 'https://example.com/thing';

describe('classifySupabaseUrl — sanitization', () => {
  it('extracts the table and DROPS the query string (never leaks filters/tokens)', () => {
    const c = classifySupabaseUrl('https://x.supabase.co/rest/v1/writing_entries?user_id=eq.abc&select=*');
    expect(c.type).toBe('rest');
    expect(c.table).toBe('writing_entries');
    expect(c.path).toBe('/rest/v1/writing_entries');
    expect(c.path).not.toContain('user_id');
    expect(c.path).not.toContain('?');
  });
  it('classifies auth without carrying any query (token could ride there)', () => {
    const c = classifySupabaseUrl('https://x.supabase.co/auth/v1/token?grant_type=refresh_token');
    expect(c.type).toBe('auth');
    expect(c.path).toBe('/auth/v1/token');
    expect(c.path).not.toContain('grant_type');
  });
  it('keeps rpc/<fn> as the table label and classifies functions/other', () => {
    expect(classifySupabaseUrl('https://x.supabase.co/rest/v1/rpc/get_error_review_session').table).toBe('rpc/get_error_review_session');
    expect(classifySupabaseUrl('https://x.supabase.co/functions/v1/foo').type).toBe('functions');
    expect(classifySupabaseUrl(OTHER).type).toBe('other');
  });
});

describe('createDiagnosticFetch — faithful pass-through', () => {
  it('returns the SAME Response and calls baseFetch exactly once (no duplication)', async () => {
    const resp = new Response('body', { status: 200 });
    const base = vi.fn(async () => resp);
    const f = createDiagnosticFetch(base as unknown as typeof fetch);
    const out = await f(OTHER);
    expect(out).toBe(resp);
    expect(base).toHaveBeenCalledTimes(1);
    expect(base).toHaveBeenCalledWith(OTHER, undefined);
  });

  it('does NOT consume the response body', async () => {
    const resp = new Response('hello', { status: 200 });
    const f = createDiagnosticFetch((async () => resp) as unknown as typeof fetch);
    const out = await f(OTHER);
    expect(out.bodyUsed).toBe(false);
    await expect(out.text()).resolves.toBe('hello'); // still readable
  });

  it('propagates thrown errors unchanged (and does not swallow AbortError)', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    const f = createDiagnosticFetch((async () => { throw abort; }) as unknown as typeof fetch);
    await expect(f(OTHER)).rejects.toBe(abort);
  });

  it('forwards init (method/headers/signal) untouched to baseFetch', async () => {
    const base = vi.fn(async () => new Response(null, { status: 204 }));
    const f = createDiagnosticFetch(base as unknown as typeof fetch);
    const init: RequestInit = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };
    await f(OTHER, init);
    expect(base).toHaveBeenCalledWith(OTHER, init);
  });
});
