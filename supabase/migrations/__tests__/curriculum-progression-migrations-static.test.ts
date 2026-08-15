/**
 * Static assertions on the curriculum-progression migrations. They don't run
 * SQL; they lock in the structural invariants the blockers require, so a future
 * edit that silently drops one fails CI.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIG = join(__dirname, '..');
const read = (f: string) => readFileSync(join(MIG, f), 'utf8');

describe('20260815121100 — resync_curriculum_progress (blockers 3, 11)', () => {
  const sql = read('20260815121100_curriculum_progress_resync_and_activity_identity.sql');

  it('is atomic per (user, version) via an advisory xact lock', () => {
    expect(sql).toMatch(/pg_advisory_xact_lock\(hashtextextended\(p_user_id::text \|\| '\|' \|\| p_curriculum_version_id::text/);
  });

  it('is SECURITY DEFINER with a pinned search_path and NOT exposed to clients', () => {
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/SET search_path = public/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.resync_curriculum_progress\(uuid, uuid\) FROM PUBLIC/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.resync_curriculum_progress\(uuid, uuid\) TO service_role/);
    // Never granted to authenticated/anon (would let a user pass any p_user_id).
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.resync_curriculum_progress[^;]*TO (authenticated|anon)/);
  });

  it('completes a recorte only when every SELECTED modality is practised (menu = rule)', () => {
    expect(sql).toMatch(/NOT v_writing OR EXISTS/);
    expect(sql).toMatch(/NOT v_listening OR EXISTS/);
    expect(sql).toMatch(/NOT v_pronunciation OR EXISTS/);
    expect(sql).toMatch(/NOT v_conversation OR EXISTS/);
    // A no-selection state can never complete a recorte (guard).
    expect(sql).toMatch(/IF \(v_writing OR v_listening OR v_pronunciation OR v_conversation\) THEN/);
  });

  it('never regresses completions (ON CONFLICT DO NOTHING) and marks curriculum_completed without reset', () => {
    expect(sql).toMatch(/INSERT INTO user_subtopic_completion[\s\S]*ON CONFLICT \(user_id, subtopic_id\) DO NOTHING/);
    expect(sql).toMatch(/WHEN v_next_subtopic IS NULL THEN 'curriculum_completed'/);
  });

  it('pointer = first NOT-completed recorte in the data-driven order (level, module.sort, subtopic.sort)', () => {
    expect(sql).toMatch(/ORDER BY s\.level_code, mo\.sort_order, s\.sort_order[\s\S]*LIMIT 1/);
  });

  it('adds the activity curricular-identity columns for writing/pronunciation/conversation', () => {
    expect(sql).toMatch(/ALTER TABLE public\.pronunciation_training_sessions[\s\S]*curriculum_version_id uuid[\s\S]*curriculum_subtopic_key text/);
    expect(sql).toMatch(/ALTER TABLE public\.english_reviews[\s\S]*curriculum_version_id uuid[\s\S]*curriculum_subtopic_key text/);
    expect(sql).toMatch(/ALTER TABLE public\.conversation_session_authorizations[\s\S]*curriculum_version_id uuid[\s\S]*curriculum_subtopic_key text/);
  });
});

describe('20260815121200 — listening cache versioned identity (blocker 5)', () => {
  const sql = read('20260815121200_listening_shared_stories_version_identity.sql');

  it('the unique constraint includes curriculum_version_id', () => {
    expect(sql).toMatch(/UNIQUE \(learning_language, curriculum_version_id, level_group, subtopic_key, practice_date, slot\)/);
  });

  it('the advisory lock key includes the curriculum version', () => {
    expect(sql).toMatch(/COALESCE\(p_curriculum_version_id::text, ''\)/);
  });

  it('EVERY story lookup is scoped by curriculum_version_id', () => {
    const matches = sql.match(/curriculum_version_id IS NOT DISTINCT FROM p_curriculum_version_id/g) ?? [];
    // reuse-ready, dead-slot, live-generation, MAX(slot)+1 — at least 4 scoped lookups.
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });

  it('preserves SECURITY DEFINER + service_role-only grant', () => {
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.acquire_or_get_listening_shared_story[^;]*TO service_role/);
  });
});
