import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const recortesDoc = readFileSync(
  join(root, 'supabase', 'curriculum_source', 'orodim_recortes_curriculo_A1_C2_V1_revisado.md'),
  'utf8',
);
const seedSql = readFileSync(
  join(root, 'supabase', 'migrations', '20260815120100_seed_curriculum_english_v1.sql'),
  'utf8',
);

const EXPECTED = { A1: 29, A2: 29, B1: 28, B2: 27, C1: 30, C2: 33 };

function countInserts(sql: string, table: string): number {
  // count "INSERT INTO public.<table> (" occurrences
  const re = new RegExp(`INSERT INTO public\\.${table} \\(`, 'g');
  return (sql.match(re) || []).length;
}

describe('curriculum source doc', () => {
  const keys = [...recortesDoc.matchAll(/^###\s+`([^`]+)`/gm)].map((m) => m[1]);

  it('has exactly 176 recortes', () => {
    expect(keys.length).toBe(176);
  });

  it('has the documented count per level', () => {
    const per: Record<string, number> = {};
    for (const k of keys) {
      const lvl = k.slice(0, 2);
      per[lvl] = (per[lvl] || 0) + 1;
    }
    expect(per).toEqual(EXPECTED);
  });

  it('uses stable SEMANTIC ids, never positional (no B1.M03.R04)', () => {
    for (const k of keys) {
      expect(k).toMatch(/^[A-C][12]\.[A-Z0-9_]+\.[A-Z0-9_]+$/);
      expect(k).not.toMatch(/\.M\d+\.R\d+$/i);
    }
  });

  it('has unique ids', () => {
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('generated seed migration', () => {
  it('inserts 176 subtopics, 48 modules, 6 transversal topics', () => {
    expect(countInserts(seedSql, 'curriculum_subtopics')).toBe(176);
    expect(countInserts(seedSql, 'curriculum_modules')).toBe(48);
    expect(countInserts(seedSql, 'curriculum_transversal_topics')).toBe(6);
  });

  it('seeds the 6 CEFR levels and the curriculum version as published', () => {
    for (const lvl of Object.keys(EXPECTED)) {
      expect(seedSql).toContain(`'${lvl}'`);
    }
    expect(seedSql).toContain("version, status");
    expect(seedSql).toContain("'published'");
  });

  it('every subtopic INSERT carries an i18n capability row', () => {
    expect(countInserts(seedSql, 'curriculum_subtopic_i18n')).toBe(176);
  });

  it('is idempotent (uses ON CONFLICT ... DO UPDATE)', () => {
    expect(seedSql).toContain('ON CONFLICT');
    expect(seedSql).not.toMatch(/\bDELETE FROM\b/);
  });
});
