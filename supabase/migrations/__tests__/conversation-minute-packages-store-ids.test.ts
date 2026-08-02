/**
 * Static SQL-text assertions for
 * 20260802215100_conversation_minute_packages_store_ids.sql — no live
 * database connection here (same posture as the other migration static
 * tests in this repository).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const sql = readFileSync(
  resolve(__dirname, '..', '20260802215100_conversation_minute_packages_store_ids.sql'),
  'utf8',
);

describe('20260802215100 — conversation_minute_packages store ids', () => {
  it('adds apple_product_id and google_product_id as nullable text columns, additively', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS apple_product_id text/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS google_product_id text/);
    expect(sql).not.toMatch(/apple_product_id text NOT NULL/);
    expect(sql).not.toMatch(/google_product_id text NOT NULL/);
  });

  it('never drops, renames, or retypes an existing column', () => {
    expect(sql).not.toMatch(/DROP COLUMN/i);
    expect(sql).not.toMatch(/RENAME COLUMN/i);
    expect(sql).not.toMatch(/ALTER COLUMN\s+\w+\s+TYPE/i);
  });

  it('never touches price, minutes, or plan compatibility in the executable SQL', () => {
    const alter = sql.slice(sql.indexOf('ALTER TABLE public.conversation_minute_packages'), sql.indexOf('UPDATE public.conversation_minute_packages'));
    const update = sql.slice(sql.indexOf('UPDATE public.conversation_minute_packages'));
    for (const block of [alter, update]) {
      expect(block).not.toMatch(/price_cents\s*=/);
      expect(block).not.toMatch(/\bminutes\s*=/);
      expect(block).not.toMatch(/compatible_plan_codes/);
    }
  });

  it('never creates a parallel table', () => {
    expect(sql).not.toMatch(/CREATE TABLE/i);
  });

  it('moves exactly the three known packages to draft/inactive, guarded by both store ids being absent', () => {
    const updateStart = sql.indexOf('UPDATE public.conversation_minute_packages');
    const update = sql.slice(updateStart);
    expect(update).toMatch(/SET\s+status = 'draft',\s*\n\s*active = false/);
    expect(update).toContain("WHERE code IN ('pacote-300-min', 'pacote-600-min', 'pacote-900-min')");
    expect(update).toMatch(/AND apple_product_id IS NULL\s*\n\s*AND google_product_id IS NULL/);
  });

  it('only ever sets status to the schema-allowed value draft (never published/archived)', () => {
    expect((sql.match(/status = '/g) ?? []).length).toBe(1);
    expect(sql).toContain("status = 'draft'");
  });

  it('contains no destructive statement and never deletes a package row', () => {
    expect(sql).not.toMatch(/\bDELETE FROM\b/i);
    expect(sql).not.toMatch(/\bDROP TABLE\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
  });

  it('never references the old app name in new text', () => {
    expect(sql).not.toMatch(/Lemon/);
  });
});
