/**
 * Static assertions for the surgical-fix migrations. They lock in the structural
 * invariants the blockers require so a future edit that drops one fails CI.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIG = join(__dirname, '..');
const read = (f: string) => readFileSync(join(MIG, f), 'utf8');

describe('20260815121400 — user_learning_paths (blockers 1, 8)', () => {
  const sql = read('20260815121400_user_learning_paths.sql');

  it('is the explicit active pointer: one active path per user (partial unique)', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_ulp_one_active_per_user[\s\S]*WHERE is_active/);
  });

  it('keeps per-language history (unique per user+language) and separates level per path', () => {
    expect(sql).toMatch(/CONSTRAINT uq_ulp_user_language UNIQUE \(user_id, learning_language\)/);
    expect(sql).toMatch(/initial_level_code\s+text/);
  });

  it('pins an explicit curriculum_version_id + interface_language (not updated_at heuristic)', () => {
    expect(sql).toMatch(/curriculum_version_id uuid NOT NULL REFERENCES public\.curriculum_versions\(id\)/);
    expect(sql).toMatch(/interface_language\s+text NOT NULL REFERENCES public\.languages\(code\)/);
  });

  it('RLS: owner reads own path; no INSERT/UPDATE policy for authenticated (server-role writes)', () => {
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/FOR SELECT TO authenticated USING \(auth\.uid\(\) = user_id\)/);
    expect(sql).not.toMatch(/FOR (INSERT|UPDATE) TO authenticated/);
  });

  it('backfills a safe active path from the existing feature preferences (no V→V migration)', () => {
    expect(sql).toMatch(/INSERT INTO public\.user_learning_paths[\s\S]*FROM public\.user_curriculum_preferences[\s\S]*ON CONFLICT \(user_id, learning_language\) DO NOTHING/);
  });
});

describe('20260815121500 — conversation mode + theme identity (blockers 3, 7)', () => {
  const sql = read('20260815121500_conversation_mode_and_theme_identity.sql');

  it('freezes conversation eligibility at start (session_mode + curriculum_practice_eligible)', () => {
    expect(sql).toMatch(/ALTER TABLE public\.conversation_session_authorizations[\s\S]*session_mode text/);
    expect(sql).toMatch(/curriculum_practice_eligible boolean NOT NULL DEFAULT false/);
    expect(sql).toMatch(/session_mode IN \('free', 'guided'\)/);
  });

  it('adds writing-mission curricular identity on generated_themes', () => {
    expect(sql).toMatch(/ALTER TABLE public\.generated_themes[\s\S]*curriculum_version_id uuid[\s\S]*curriculum_subtopic_key text/);
  });
});

describe('20260815121600 — conversation_pref_fragments (blocker 2)', () => {
  const sql = read('20260815121600_conversation_pref_fragments.sql');

  it('creates the data-driven personalization fragment table keyed by interface_language', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.conversation_pref_fragments/);
    expect(sql).toMatch(/PRIMARY KEY \(dimension, value, interface_language\)/);
    expect(sql).toMatch(/FOR SELECT TO authenticated USING \(true\)/);
  });

  it('seeds BOTH pt-BR and en text for every dimension (no single-language authority)', () => {
    for (const dim of ['pace', 'formality', 'humor', 'roast', 'initiative', 'correction_timing', 'correction_scope', 'correction_detail', 'profanity']) {
      expect(sql).toMatch(new RegExp(`'${dim}'[^\\n]*'pt-BR'`));
      expect(sql).toMatch(new RegExp(`'${dim}'[^\\n]*'en'`));
    }
  });
});

describe('20260815121700 — conversation.free context framing moved to the template (blocker 2)', () => {
  const sql = read('20260815121700_conversation_free_context_framing.sql');
  it('injects the framing into the template (data), idempotently, around {{session_context}}', () => {
    expect(sql).toMatch(/UPDATE public\.prompt_templates/);
    expect(sql).toMatch(/template_key = 'conversation\.free'/);
    expect(sql).toMatch(/NOT LIKE '%## Contexto da sessão \(dados\)%'/); // idempotent guard
  });
});
