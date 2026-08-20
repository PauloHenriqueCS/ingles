/**
 * Source-level guards for the "Versão 2 is limited to ONE analysis per review"
 * fix (problem 10). V1 was already capped by an atomic reservation; V2 had none,
 * so editing the rewrite and re-clicking "Comparar versão 2" ran unlimited AI
 * calls. These lock in the server-authoritative reservation + the UI reflecting
 * it, following the repo's static-wiring convention.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const endpointSrc = readFileSync(join(__dirname, '..', 'writing-rewrite-evaluate.ts'), 'utf8');
const migrationSrc = readFileSync(
  join(__dirname, '..', '..', 'supabase', 'migrations', '20260820130000_writing_rewrite_reservation.sql'),
  'utf8',
);
const rewriteSectionSrc = readFileSync(
  join(__dirname, '..', '..', 'src', 'components', 'RewriteSection.tsx'),
  'utf8',
);

describe('V2 endpoint reserves one analysis per review (authoritative + idempotent)', () => {
  it('reserves BEFORE creating an attempt or calling the AI', () => {
    const reserveIdx = endpointSrc.indexOf("rpc('reserve_writing_rewrite'");
    const aiIdx = endpointSrc.indexOf('evaluateWritingRewrite(supabase');
    const createIdx = endpointSrc.indexOf('createRewriteAttempt(supabase');
    expect(reserveIdx).toBeGreaterThan(0);
    expect(reserveIdx).toBeLessThan(aiIdx);
    expect(reserveIdx).toBeLessThan(createIdx);
  });

  it('replays the stored evaluation when already analyzed (no second AI call)', () => {
    const alreadyIdx = endpointSrc.indexOf("reservationStatus === 'already_evaluated'");
    const dtoIdx = endpointSrc.indexOf('buildPublicRewriteDTO', alreadyIdx);
    const replayReturnIdx = endpointSrc.indexOf('alreadyAnalyzed: true', alreadyIdx);
    expect(alreadyIdx).toBeGreaterThan(0);
    expect(dtoIdx).toBeGreaterThan(alreadyIdx);
    // the replay returns BEFORE the AI call site
    expect(replayReturnIdx).toBeGreaterThan(0);
    expect(replayReturnIdx).toBeLessThan(endpointSrc.indexOf('evaluateWritingRewrite(supabase'));
  });

  it('returns 409 when an evaluation for the review is already in flight', () => {
    const inProgIdx = endpointSrc.indexOf("reservationStatus === 'in_progress'");
    expect(inProgIdx).toBeGreaterThan(0);
    expect(endpointSrc.indexOf('409', inProgIdx)).toBeGreaterThan(inProgIdx);
    expect(endpointSrc).toContain('V2_EVALUATION_IN_PROGRESS');
  });

  it('completes the reservation on success and releases it on failure (retry allowed)', () => {
    const aiIdx = endpointSrc.indexOf('evaluateWritingRewrite(supabase');
    const completeIdx = endpointSrc.indexOf('complete_writing_rewrite_reservation', aiIdx);
    expect(completeIdx).toBeGreaterThan(aiIdx); // completed only AFTER a successful evaluation
    expect(endpointSrc).toContain('fail_writing_rewrite_reservation');
    const catchIdx = endpointSrc.indexOf('catch (err)');
    expect(endpointSrc.indexOf('releaseRewriteReservation', catchIdx)).toBeGreaterThan(catchIdx);
  });
});

describe('reservation migration is service-role-only and one-per-review', () => {
  it('creates the reservation table with a UNIQUE (user_id, review_id) guard', () => {
    expect(migrationSrc).toContain('CREATE TABLE IF NOT EXISTS public.writing_rewrite_reservations');
    expect(migrationSrc).toMatch(/UNIQUE \(user_id, review_id\)/);
    expect(migrationSrc).toContain('ENABLE ROW LEVEL SECURITY');
  });

  it('defines reserve/complete/fail RPCs under an advisory lock, service_role only', () => {
    for (const fn of ['reserve_writing_rewrite', 'complete_writing_rewrite_reservation', 'fail_writing_rewrite_reservation']) {
      expect(migrationSrc).toContain(`FUNCTION public.${fn}`);
      expect(migrationSrc).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public.${fn}\\([^)]*\\) TO service_role`));
      expect(migrationSrc).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public.${fn}\\([^)]*\\) FROM PUBLIC, anon, authenticated`));
    }
    expect(migrationSrc).toContain("pg_advisory_xact_lock(hashtext('writing_rewrite')");
    expect(migrationSrc).toContain('SECURITY DEFINER');
  });
});

describe('RewriteSection reflects the one-analysis rule', () => {
  it('locks the compare button and the textarea once analyzed', () => {
    expect(rewriteSectionSrc).toMatch(/disabled=\{isComparing \|\| finalCorrectState === 'loading' \|\| hasCompared\}/);
    expect(rewriteSectionSrc).toContain('readOnly={hasCompared}');
    // guards the handler itself, not only the button
    const compareIdx = rewriteSectionSrc.indexOf('async function compare()');
    const guardIdx = rewriteSectionSrc.indexOf("compareState === 'done' || compareState === 'loading') return", compareIdx);
    expect(guardIdx).toBeGreaterThan(compareIdx);
  });
});
