// Static checks for the retention v2 migration: it must (a) build REAL coverage
// intervals via gaps-and-islands (not a single min/max extent), and (b) keep the
// same service-role-only security boundary as the other admin_*_v1 RPCs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIG = join(__dirname, '..');
const sql = readFileSync(join(MIG, '20260829193000_admin_retention_coverage_intervals.sql'), 'utf8');

describe('20260829193000 — retention coverage intervals', () => {
  it('replaces the extent model with a real interval-merge (gaps-and-islands + grace)', () => {
    expect(sql).toMatch(/create or replace function public\.admin_retention_paid_intervals\(\)/i);
    // a new island only starts on a real lapse beyond the grace window
    expect(sql).toMatch(/starts_at > prev_max_end \+ interval '2 days'/i);
    expect(sql).toMatch(/sum\(new_island\) over/i);
    // the superseded extent helper is dropped
    expect(sql).toMatch(/drop function if exists public\.admin_retention_paid_coverage\(\)/i);
  });

  it('adds the subscription time-series RPC used by the trend chart', () => {
    expect(sql).toMatch(/create or replace function public\.admin_get_subscription_timeseries_v1\(/i);
    expect(sql).toMatch(/'churn_effective'/);
    expect(sql).toMatch(/'new_payers'/);
    expect(sql).toMatch(/'active_end'/);
  });

  it('keeps every function service-role only (REVOKE public/anon/authenticated, GRANT service_role)', () => {
    for (const fn of [
      'admin_retention_paid_intervals()',
      'admin_get_retention_overview_v1(timestamptz, timestamptz)',
      'admin_get_subscription_cohorts_v1(integer)',
      'admin_get_subscription_timeseries_v1(timestamptz, timestamptz, text)',
    ]) {
      expect(sql).toContain(`grant execute on function public.${fn} to service_role`);
      expect(sql).toContain(`revoke all on function public.${fn} from public`);
      expect(sql).toContain(`revoke all on function public.${fn} from authenticated`);
    }
  });

  it('pins a safe search_path on every function', () => {
    const defs = sql.match(/set search_path = public/gi) ?? [];
    expect(defs.length).toBeGreaterThanOrEqual(4);
  });
});
