/**
 * Static SQL-text assertions for
 * 20260821190000_reclaim_stale_pronunciation_training_attempt.sql — no live DB.
 *
 * Regression: a page reload between /start and the upload left the session row
 * in 'processing' with a live active_attempt_id and no way out (only /complete
 * and /fail could clear it, and both need the client that just died), so every
 * later attempt got ASSESSMENT_IN_PROGRESS and the user was locked out of the
 * activity for the rest of the day.
 *
 * The reclaim must NOT hand out extra analyses: the abandoned row is already
 * counted as consumed, so taking it over may not move the counters.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const sql = readFileSync(
  resolve(__dirname, '..', '20260821190000_reclaim_stale_pronunciation_training_attempt.sql'),
  'utf8',
);
const executableSql = sql
  .split('\n')
  .map((line) => (line.trim().startsWith('--') ? '' : line))
  .join('\n');

describe('20260821190000 — reclaim a stale pronunciation-training attempt', () => {
  it('reclaims a processing row whose attempt has been idle past the threshold', () => {
    expect(executableSql).toMatch(/v_attempt_start IS NULL OR v_attempt_start < NOW\(\) - c_reclaim_after/);
    expect(executableSql).toMatch(/'action',\s*'reclaimed'/);
  });

  it('uses a threshold longer than the server assessor cap and the function ceiling', () => {
    const match = executableSql.match(/c_reclaim_after\s+CONSTANT INTERVAL\s*:=\s*INTERVAL '(\d+) minutes'/);
    expect(match).not.toBeNull();
    // Assessor caps a run at 240 s and Vercel kills the function at 300 s, so a
    // shorter window could steal a row from a still-running assessment.
    expect(Number(match![1])).toBeGreaterThanOrEqual(6);
  });

  it('still rejects a genuinely in-flight attempt from another client', () => {
    expect(executableSql).toMatch(/'error',\s*'ASSESSMENT_IN_PROGRESS'/);
  });

  it('keeps the same-attempt retry idempotent', () => {
    expect(executableSql).toMatch(/IF v_active_attempt = p_attempt_id THEN/);
    expect(executableSql).toMatch(/'action',\s*'existing_processing'/);
  });

  it('does not re-check the daily limit on the reclaim path (the row is already consumed)', () => {
    // Exactly one daily-limit gate, and it belongs to the reserve branch where
    // the row is not yet part of v_consumed. A second gate would count the row
    // against itself and wrongly block the reclaim.
    const gates = executableSql.match(/v_consumed >= COALESCE\(p_effective_limit/g) ?? [];
    expect(gates).toHaveLength(1);
  });

  it('leaves the consumption accounting untouched', () => {
    // Reclaim keeps the row in 'processing' — it must not flip status, which is
    // what the quota counter keys on.
    expect(executableSql).toMatch(/status IN \('processing', 'completed'\)/);
    const reclaimBlock = executableSql.slice(
      executableSql.indexOf('v_attempt_start IS NULL'),
      executableSql.indexOf("'action', 'reclaimed'"),
    );
    expect(reclaimBlock).not.toMatch(/SET[\s\S]*status\s*=/);
  });

  it('preserves SECURITY DEFINER, search_path and the service_role-only grant', () => {
    expect(executableSql).toMatch(/SECURITY DEFINER/);
    expect(executableSql).toMatch(/SET search_path TO 'public'/);
    expect(executableSql).toMatch(/REVOKE ALL ON FUNCTION public\.reserve_pronunciation_training_assessment[\s\S]*FROM PUBLIC, anon, authenticated/);
    expect(executableSql).toMatch(/GRANT EXECUTE ON FUNCTION public\.reserve_pronunciation_training_assessment[\s\S]*TO service_role/);
  });

  it('is idempotent (CREATE OR REPLACE, no destructive DDL)', () => {
    expect(executableSql).toMatch(/CREATE OR REPLACE FUNCTION public\.reserve_pronunciation_training_assessment/);
    expect(executableSql).not.toMatch(/DROP TABLE|DELETE FROM|TRUNCATE/i);
  });
});
