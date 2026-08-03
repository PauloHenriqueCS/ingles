/**
 * Static assertions for supabase/migrations/20260803000000_plans_store_ids.sql
 * — the compatibility marker for a version owned by ingles-dashboad (see
 * supabase/MIGRATIONS.md, "Coordenação com ingles-dashboad", item 5). This
 * file must never execute anything; these tests exist specifically to catch
 * a future edit that accidentally turns it into real SQL.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const sql = readFileSync(
  resolve(__dirname, '..', '20260803000000_plans_store_ids.sql'),
  'utf8',
);

describe('20260803000000 — plans_store_ids compatibility marker', () => {
  it('contains only SQL comment lines and blank lines — no executable statement', () => {
    const nonCommentLines = sql
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('--'));
    expect(nonCommentLines).toEqual([]);
  });

  // Keyword checks (ALTER TABLE, GRANT, etc.) are deliberately not repeated
  // here as substring scans: the header comment names those keywords in
  // prose to explain what this file must never contain, which would trip a
  // naive regex on a comment-only file. The line-by-line check above is the
  // rigorous guarantee — every non-blank line is a comment, so no keyword
  // can appear on an executable line by construction.

  it('never calls a function (no SELECT/PERFORM of an RPC)', () => {
    expect(sql).not.toMatch(/\b(SELECT|PERFORM)\s+public\./i);
  });

  it('never references the old app name in new text', () => {
    expect(sql).not.toMatch(/Lemon/);
  });
});
