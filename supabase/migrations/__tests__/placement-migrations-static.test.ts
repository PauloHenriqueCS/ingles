/**
 * Static assertions locking in the security + monotonicity invariants of the
 * placement migrations, so a future edit that weakens one fails CI:
 *   - the answer key is PRIVATE (never readable by an authenticated client);
 *   - visible options carry NO correctness flag;
 *   - the result apply is MONOTONIC (only ADDS completions below the target);
 *   - placement is concluded EXACTLY once (partial unique index);
 *   - the seed encodes the exact adaptive tree + all answer keys + the rubric.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIG = join(__dirname, '..');
const read = (f: string) => readFileSync(join(MIG, f), 'utf8');

describe('20260815130000 — placement foundation', () => {
  const sql = read('20260815130000_placement_foundation.sql');

  it('answer key table is PRIVATE: RLS on, revoked from authenticated, service_role only, NO policy', () => {
    expect(sql).toMatch(/ALTER TABLE public\.placement_question_keys ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/REVOKE ALL ON public\.placement_question_keys FROM authenticated/);
    expect(sql).toMatch(/GRANT ALL ON public\.placement_question_keys TO service_role/);
    // No SELECT policy for authenticated on the key table → RLS denies by default.
    expect(sql).not.toMatch(/CREATE POLICY[^;]*ON public\.placement_question_keys/);
    expect(sql).not.toMatch(/GRANT SELECT ON public\.placement_question_keys TO authenticated/);
  });

  it('visible options table carries NO correctness column', () => {
    const optBlock = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS public.placement_question_options'), sql.indexOf('CREATE TABLE IF NOT EXISTS public.placement_question_keys'));
    expect(optBlock).not.toMatch(/is_correct/);
  });

  it('objective answers + C2 evaluations are private (revoked from authenticated)', () => {
    expect(sql).toMatch(/placement_attempt_answers[\s\S]*placement_c2_evaluations/);
    expect(sql).toMatch(/REVOKE ALL ON public\.%I FROM authenticated/); // the private-tables loop
  });

  it('conclusion EXACTLY once + single open attempt (partial unique indexes)', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_placement_one_completed[\s\S]*WHERE status = 'completed'/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_placement_one_open[\s\S]*WHERE status IN \('in_progress','pending_evaluation'\)/);
  });

  it('apply-result is MONOTONIC: only ADDS completions strictly below the target level, never deletes', () => {
    const fn = sql.slice(sql.indexOf('FUNCTION public.placement_apply_result_v1'));
    expect(fn).toMatch(/INSERT INTO user_subtopic_completion/);
    expect(fn).toMatch(/pl\.sort_order < v_target_sort/);
    expect(fn).toMatch(/ON CONFLICT \(user_id, subtopic_id\) DO NOTHING/);
    expect(fn).toMatch(/resync_curriculum_progress/);
    // Never lowers: the function must not delete completions nor write a level directly.
    expect(fn).not.toMatch(/DELETE FROM user_subtopic_completion/);
    expect(fn).not.toMatch(/DELETE FROM user_subtopic_modality_progress/);
  });

  it('apply-result RPC is not executable by authenticated (service_role only)', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.placement_apply_result_v1\(uuid, uuid, text\) FROM authenticated/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.placement_apply_result_v1\(uuid, uuid, text\) TO service_role/);
  });
});

describe('20260815130100 — English Placement V1 seed', () => {
  const sql = read('20260815130100_seed_placement_english_v1.sql');

  it('seeds the active English test starting at B1', () => {
    expect(sql).toMatch(/'english-placement',\s*'en',\s*'CEFR',\s*1,\s*'English Placement V1',\s*true,\s*'B1'/);
  });

  it('encodes the adaptive tree (A2→A1/A2, B1→A2/B2, B2→B1/C1, C1→B2/C2_GATE, C2_GATE→C1/C2)', () => {
    expect(sql).toMatch(/\('A2',\s*'objective',\s*1,\s*2,\s*NULL::text,\s*NULL::text,\s*'A2',\s*'A1'\)/);
    expect(sql).toMatch(/\('B1',\s*'objective',\s*2,\s*2,\s*'B2',\s*'A2',\s*NULL,\s*NULL\)/);
    expect(sql).toMatch(/\('B2',\s*'objective',\s*3,\s*2,\s*'C1',\s*NULL,\s*NULL,\s*'B1'\)/);
    expect(sql).toMatch(/\('C1',\s*'objective',\s*4,\s*2,\s*'C2_GATE',\s*NULL,\s*NULL,\s*'B2'\)/);
    expect(sql).toMatch(/\('C2_GATE',\s*'c2_gate',\s*5,\s*2,\s*NULL,\s*NULL,\s*'C2',\s*'C1'\)/);
  });

  it('seeds the private answer key for all 12 objective questions', () => {
    for (const q of ['A2.1', 'A2.2', 'A2.TB', 'B1.1', 'B1.2', 'B1.TB', 'B2.1', 'B2.2', 'B2.TB', 'C1.1', 'C1.2', 'C1.TB']) {
      expect(sql).toMatch(new RegExp(`\\('${q.replace('.', '\\.')}','[A-E]'\\)`));
    }
    expect(sql).toMatch(/INSERT INTO public\.placement_question_keys/);
  });

  it('seeds the two C2 open tasks with time limits (60s / 45s)', () => {
    expect(sql).toMatch(/'C2\.manager'[\s\S]*"time_limit_seconds": 60/);
    expect(sql).toMatch(/'C2\.friend'[\s\S]*"time_limit_seconds": 45/);
  });

  it('seeds the C2 rubric (5 criteria, threshold 8, max 10) and its prompt template', () => {
    expect(sql).toMatch(/pass_threshold[\s\S]*8, 10, 'placement\.c2_evaluation'/);
    for (const c of ['meaning_preservation', 'register_adaptation', 'naturalness', 'precision_nuance', 'reformulation_flexibility']) {
      expect(sql).toMatch(new RegExp(`"${c}"`));
    }
    expect(sql).toMatch(/INSERT INTO public\.prompt_templates[\s\S]*'placement\.c2_evaluation'/);
  });

  it('seeds interface copy with {level}/{language} placeholders', () => {
    expect(sql).toMatch(/'result_headline',\s*'Seu nível inicial: \{level\}'/);
    expect(sql).toMatch(/'onboarding_title',\s*'Descubra seu nível de \{language\}'/);
  });
});

describe('20260815140000 — resync ambiguous current_level_code fix (bug 42702)', () => {
  const sql = read('20260815140000_fix_resync_ambiguous_level_code.sql');

  it('replaces resync_curriculum_progress', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.resync_curriculum_progress/);
  });

  it('qualifies the RHS level reference so it is NOT ambiguous with the OUT column', () => {
    // The fix: COALESCE(v_next_level, user_curriculum_progress.current_level_code)
    expect(sql).toMatch(/current_level_code\s*=\s*COALESCE\(v_next_level,\s*user_curriculum_progress\.current_level_code\)/);
    // The old, ambiguous bare form must be gone.
    expect(sql).not.toMatch(/COALESCE\(v_next_level,\s*current_level_code\)/);
  });
});
