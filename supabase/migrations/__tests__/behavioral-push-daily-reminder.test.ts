/**
 * Static assertions on the behavioral-push v2 (simple daily reminder) migrations.
 * They don't run SQL; they lock in the structural invariants of the eligibility
 * rule so a future edit can't silently reintroduce a gate the product removed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIG = join(__dirname, '..');
const read = (f: string) => readFileSync(join(MIG, f), 'utf8');

describe('20260910120000 — daily reminder base (types, snapshots, no cooldown)', () => {
  const sql = read('20260910120000_behavioral_push_daily_reminder.sql');

  it('CHECK accepts the new type AND keeps the legacy ones (history intact)', () => {
    const block = sql.slice(sql.indexOf('bpe_push_type_valid'));
    expect(block).toContain("'practice_reminder_behavioral'");
    expect(block).toContain("'streak_risk'");
    expect(block).toContain("'abandonment'");
  });

  it('adds the copy snapshot columns', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS title_snapshot text/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS body_snapshot\s+text/);
  });

  it('claim carries the title/body snapshot params (11-arg) and is re-granted', () => {
    expect(sql).toMatch(/p_title_snapshot text DEFAULT NULL/);
    expect(sql).toMatch(/p_body_snapshot text DEFAULT NULL/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.behavioral_push_claim\([^)]*text, text\) TO service_role/);
  });

  it('removes the 72h cooldown from both candidates and revalidate', () => {
    // Neither function may reference the sent-within-cooldown window anymore.
    expect(sql).not.toContain("sent_at > now() - make_interval(hours => p_cooldown_hours)");
  });

  it('ON CONFLICT (user_id, local_date) DO NOTHING is preserved (idempotency)', () => {
    expect(sql).toMatch(/ON CONFLICT \(user_id, local_date\) DO NOTHING/);
  });
});

describe('20260911120000 — drop the reactivation lookback gate (dormancy never excludes)', () => {
  const sql = read('20260911120000_behavioral_push_drop_reactivation_gate.sql');
  // The WHERE clause of the final SELECT is what encodes eligibility.
  const whereClause = sql.slice(sql.lastIndexOf('LEFT JOIN last_act'));

  it('does NOT gate on recent activity or recent signup (bound removed)', () => {
    // The removed bound referenced account_created_date >= since and
    // array_length(active_dates) > 0 as an OR gate. Neither may appear in WHERE.
    expect(whereClause).not.toContain('account_created_date >=');
    expect(whereClause).not.toMatch(/array_length\(a\.active_dates, 1\), 0\) > 0/);
  });

  it('keeps the required gates: configured weekday, not-practiced, idempotency', () => {
    expect(whereClause).toContain('EXTRACT(DOW FROM p_local_date)');
    expect(whereClause).toContain('tg.user_id IS NULL'); // anti-nag (practiced_today = false)
    // scenario 6: a same-day event makes the user ineligible → no duplicate.
    expect(whereClause).toMatch(/NOT EXISTS \([\s\S]*behavioral_push_events e[\s\S]*local_date = p_local_date/);
  });

  it('keeps only the truly-necessary technical exclusions (deactivation, push opt-out)', () => {
    expect(whereClause).toContain('user_account_deactivations');
    expect(whereClause).toContain('user_communication_blocks');
  });

  it('never reintroduces a cooldown', () => {
    expect(sql).not.toContain('p_cooldown_hours)');
  });
});

describe('20260911130000 — keyset pagination (scalability, no OFFSET, no fixed cap)', () => {
  const sql = read('20260911130000_behavioral_push_candidates_keyset.sql');
  const whereClause = sql.slice(sql.lastIndexOf('LEFT JOIN last_act'));

  it('paginates by a stable keyset cursor on user_id, not OFFSET', () => {
    expect(sql).toMatch(/p_after_user_id uuid DEFAULT NULL/);
    expect(whereClause).toContain('a.user_id > p_after_user_id');
    expect(sql).toContain('ORDER BY a.user_id');
    expect(sql).toContain('LIMIT p_limit');
    // No OFFSET pagination and no p_offset parameter (that was the old,
    // non-scalable strategy). Note: the header COMMENT explains the removal, so
    // we assert on the executable shapes, not the word in prose.
    expect(sql).not.toMatch(/LIMIT\s+p_limit\s+OFFSET/i);
    expect(sql).not.toMatch(/p_offset\s+int/);
  });

  it('drops the old int-offset signature and re-grants the new uuid one', () => {
    expect(sql).toMatch(/DROP FUNCTION IF EXISTS public\.behavioral_push_candidates\(date, int, int, int, int\)/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.behavioral_push_candidates\(date, int, int, uuid\) TO service_role/);
  });

  it('does NOT change eligibility: gates + idempotency preserved, still no bound/cooldown', () => {
    expect(whereClause).toContain('EXTRACT(DOW FROM p_local_date)');
    expect(whereClause).toContain('tg.user_id IS NULL');
    expect(whereClause).toMatch(/NOT EXISTS \([\s\S]*behavioral_push_events e[\s\S]*local_date = p_local_date/);
    expect(whereClause).toContain('user_account_deactivations');
    expect(whereClause).toContain('user_communication_blocks');
    expect(whereClause).not.toContain('account_created_date >='); // no reactivation bound
    expect(sql).not.toContain('make_interval(hours => p_cooldown_hours)'); // no cooldown
  });
});
