/**
 * Static SQL-text assertions for
 * 20260803233000_revenuecat_webhook_events.sql — no live database
 * connection here (same posture as the other migration static tests).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const sql = readFileSync(
  resolve(__dirname, '..', '20260803233000_revenuecat_webhook_events.sql'),
  'utf8',
);

// Comments in this file's own prose legitimately name things it explicitly
// does NOT touch (e.g. "nenhuma mudança em ... plan_capability_values") —
// checks for "never contains X" must only ever scan executable SQL, never
// the header/inline commentary, or they false-positive on the very
// sentence explaining the guarantee.
const executableSql = sql
  .split('\n')
  .map((line) => (line.trim().startsWith('--') ? '' : line))
  .join('\n');

describe('20260803233000 — revenuecat_webhook_events + credits idempotency index', () => {
  it('creates the events table with a unique natural key on revenuecat_event_id', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.revenuecat_webhook_events/);
    expect(sql).toMatch(/CONSTRAINT revenuecat_webhook_events_event_id_key UNIQUE \(revenuecat_event_id\)/);
  });

  it('includes every field required by the task spec', () => {
    const required = [
      'revenuecat_event_id', 'event_type', 'environment', 'app_user_id', 'product_id',
      'transaction_id', 'original_transaction_id', 'payload_hash', 'processing_status',
      'received_at', 'processed_at', 'error_message', 'created_at', 'updated_at',
    ];
    for (const field of required) {
      expect(sql, `missing field ${field}`).toContain(field);
    }
  });

  it('never stores a raw payload column, only a hash', () => {
    expect(sql).not.toMatch(/\bpayload\s+(text|jsonb)\b/i);
    expect(sql).toContain('payload_hash');
  });

  it('enables RLS and creates zero policies on the events table', () => {
    expect(sql).toMatch(/ALTER TABLE public\.revenuecat_webhook_events ENABLE ROW LEVEL SECURITY/);
    expect(sql).not.toMatch(/CREATE POLICY/i);
  });

  it('grants only service_role — never authenticated, anon, or PUBLIC', () => {
    expect(sql).toMatch(/GRANT SELECT, INSERT, UPDATE ON public\.revenuecat_webhook_events TO service_role;/);
    expect(sql).toMatch(/REVOKE ALL ON public\.revenuecat_webhook_events FROM PUBLIC;/);
    expect(sql).toMatch(/REVOKE ALL ON public\.revenuecat_webhook_events FROM anon;/);
    expect(sql).toMatch(/REVOKE ALL ON public\.revenuecat_webhook_events FROM authenticated;/);
    expect(sql).not.toMatch(/GRANT[^;]*TO authenticated/);
  });

  it('never grants DELETE on the events table (append-only audit log)', () => {
    expect(sql).not.toMatch(/GRANT[^;]*DELETE[^;]*TO service_role/);
  });

  it('adds the minute-credits idempotency index without touching existing grants on that table', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_user_conversation_credits_external_reference\s*\n\s*ON public\.user_conversation_credits \(source, external_reference\)\s*\n\s*WHERE external_reference IS NOT NULL;/,
    );
    expect(executableSql).not.toMatch(/GRANT[^;]*user_conversation_credits/);
    expect(executableSql).not.toMatch(/REVOKE[^;]*user_conversation_credits/);
  });

  it('never touches plans, capability values, prices, or trial rules', () => {
    expect(executableSql).not.toMatch(/\bplan_capability_values\b/);
    expect(executableSql).not.toMatch(/\bmonthly_price_cents\b/);
    expect(executableSql).not.toMatch(/UPDATE public\.plans\b/i);
  });

  it('contains no destructive statement', () => {
    expect(sql).not.toMatch(/\bDELETE FROM\b/i);
    expect(sql).not.toMatch(/\bDROP TABLE\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
  });

  it('never references the old app name in new text', () => {
    expect(sql).not.toMatch(/Lemon/);
  });
});
