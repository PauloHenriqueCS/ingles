/**
 * Static SQL-text assertions for
 * 20260812160000_add_version_2_final_text_to_reviews.sql — no live database
 * connection here (same posture as the other migration static tests).
 *
 * This migration is the fix for "A versão final foi gerada, mas não foi
 * possível salvá-la": prod/homolog were missing english_reviews.version_2_final_text
 * because the original column migration predated the baseline cut and was never
 * applied. It must be strictly additive (one nullable column, idempotent) and
 * must not touch RLS, policies, grants or data.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const sql = readFileSync(
  resolve(__dirname, '..', '20260812160000_add_version_2_final_text_to_reviews.sql'),
  'utf8',
);

const executableSql = sql
  .split('\n')
  .map((line) => (line.trim().startsWith('--') ? '' : line))
  .join('\n');

describe('20260812160000 — add version_2_final_text to english_reviews', () => {
  it('adds the version_2_final_text TEXT column idempotently', () => {
    expect(executableSql).toMatch(
      /ALTER TABLE public\.english_reviews\s*\n\s*ADD COLUMN IF NOT EXISTS version_2_final_text TEXT;/,
    );
  });

  it('targets exactly one column and one table (no scope creep)', () => {
    // Only a single ALTER TABLE statement, only english_reviews.
    const alterCount = (executableSql.match(/ALTER TABLE/gi) || []).length;
    expect(alterCount).toBe(1);
    expect(executableSql).not.toMatch(/ALTER TABLE(?!\s+public\.english_reviews)/i);
  });

  it('never touches RLS, policies, or grants (purely additive)', () => {
    expect(executableSql).not.toMatch(/ROW LEVEL SECURITY/i);
    expect(executableSql).not.toMatch(/CREATE POLICY/i);
    expect(executableSql).not.toMatch(/DROP POLICY/i);
    expect(executableSql).not.toMatch(/\bGRANT\b/i);
    expect(executableSql).not.toMatch(/\bREVOKE\b/i);
  });

  it('contains no destructive statement', () => {
    expect(executableSql).not.toMatch(/\bDELETE FROM\b/i);
    expect(executableSql).not.toMatch(/\bDROP (TABLE|COLUMN)\b/i);
    expect(executableSql).not.toMatch(/\bTRUNCATE\b/i);
    expect(executableSql).not.toMatch(/\bUPDATE\s+public\./i);
  });

  it('never references the old app name in new text', () => {
    expect(sql).not.toMatch(/Lemon/);
  });
});
