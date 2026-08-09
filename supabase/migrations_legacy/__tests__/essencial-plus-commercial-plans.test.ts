/**
 * Static SQL-text assertions for
 * 20260727230600_essencial_plus_commercial_plans.sql — no live database
 * connection here (same posture as the other migration static tests in
 * this directory).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const sql = readFileSync(
  resolve(__dirname, '..', '..', 'migrations', '20260727230600_essencial_plus_commercial_plans.sql'),
  'utf8',
);

function planBlock(code: string): string {
  const start = sql.indexOf(`WHERE code = '${code}'`);
  const nextMarker = code === 'essencial' ? "WHERE code = 'plus'" : 'END $$;';
  const end = sql.indexOf(nextMarker, start);
  return sql.slice(start, end === -1 ? undefined : end);
}

describe('20260727230000 — essencial/plus commercial plans', () => {
  it('never publishes a version — the header discusses publish_plan_version by name (why it is NOT called here), but never actually invokes it', () => {
    expect(sql).not.toMatch(/(SELECT|PERFORM)\s+public\.publish_plan_version\(/);
  });

  it('creates both plans in draft status, never active, never is_default', () => {
    for (const code of ['essencial', 'plus']) {
      const block = planBlock(code);
      expect(block).toMatch(/'draft', FALSE, TRUE,/);
    }
  });

  it('creates both plan_versions in draft status', () => {
    expect((sql.match(/VALUES \(v_(essential|plus)_plan_id, 1, 'draft', 1\)/g) ?? []).length).toBe(2);
  });

  it('is idempotent — guards every INSERT with an existence check', () => {
    expect(sql).toMatch(/IF v_essential_plan_id IS NULL THEN/);
    expect(sql).toMatch(/IF v_plus_plan_id IS NULL THEN/);
    expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM public\.plan_versions WHERE plan_id = v_essential_plan_id\) THEN/);
    expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM public\.plan_versions WHERE plan_id = v_plus_plan_id\) THEN/);
  });

  it('prices match product decision: Essencial R$34,90 (3490 cents), Plus R$59,90 (5990 cents)', () => {
    expect(planBlock('essencial')).toContain('3490,');
    expect(planBlock('plus')).toContain('5990,');
  });

  it('Essencial seeds 1x/day writing/pronunciation/listening and a 1800s (30min) monthly conversation quota, extra-purchase enabled', () => {
    const essentialCaps = sql.slice(sql.indexOf('v_essential_version_id, '), sql.indexOf("-- ── Plus"));
    expect(essentialCaps).toContain("'writing.theme_generations_per_day', '1', 'day'");
    expect(essentialCaps).toContain("'writing.reviews_per_day', '1', 'day'");
    expect(essentialCaps).toContain("'pronunciation.evaluations_per_day', '1', 'day'");
    expect(essentialCaps).toContain("'listening.stories_per_day', '1', 'day'");
    expect(essentialCaps).toContain("'conversation.realtime.seconds.monthly', '1800', 'month'");
    expect(essentialCaps).toContain("'conversation.extra_purchase_enabled', 'true', 'none'");
  });

  it('Plus seeds 3x/day writing/pronunciation/listening, extra-purchase also enabled, and deliberately omits the monthly conversation quota (not yet decided)', () => {
    const plusCaps = sql.slice(sql.indexOf('v_plus_version_id, '));
    expect(plusCaps).toContain("'writing.theme_generations_per_day', '3', 'day'");
    expect(plusCaps).toContain("'writing.reviews_per_day', '3', 'day'");
    expect(plusCaps).toContain("'pronunciation.evaluations_per_day', '3', 'day'");
    expect(plusCaps).toContain("'listening.stories_per_day', '3', 'day'");
    expect(plusCaps).toContain("'conversation.extra_purchase_enabled', 'true', 'none'");
    expect(plusCaps).not.toContain('conversation.realtime.seconds.monthly');
  });

  it('never seeds a field-limit with an invented number (max_characters_per_text, max_recording_seconds) — checked in the actual INSERT blocks, not the header commentary that explains the omission', () => {
    const essentialCaps = sql.slice(sql.indexOf('v_essential_version_id, '), sql.indexOf('-- ── Plus'));
    const plusCaps = sql.slice(sql.indexOf('v_plus_version_id, '));
    for (const block of [essentialCaps, plusCaps]) {
      expect(block).not.toContain('max_characters_per_text');
      expect(block).not.toContain('max_recording_seconds');
    }
  });

  it('never inserts a new capability_definitions row — every key used already exists in the canonical catalog', () => {
    expect(sql).not.toMatch(/INSERT INTO public\.capability_definitions/);
  });

  it('contains no destructive statement', () => {
    expect(sql).not.toMatch(/\bDELETE FROM\b/i);
    expect(sql).not.toMatch(/\bDROP TABLE\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
  });
});
