/**
 * ROOT-1 — a curricular Pronunciation session must never be delivered before
 * its curriculum identity (version + recorte) is DURABLY persisted.
 *
 * These static assertions lock in the structural fix so a future edit that
 * regresses it fails CI:
 *   1. create_pronunciation_training_text persists the identity IN THE SAME
 *      atomic INSERT that creates the session (8-arg overload), and returns it.
 *   2. The handler passes the resolved identity into that RPC and no longer
 *      relies on a best-effort post-RPC UPDATE whose { error } was ignored.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIG = join(__dirname, '..', '..', 'supabase', 'migrations');
const HANDLER = join(__dirname, '..', 'pronunciation-training', '[...slug].ts');
const readMig = (f: string) => readFileSync(join(MIG, f), 'utf8');

describe('20260815122000 — pronunciation identity persisted atomically (ROOT-1)', () => {
  const sql = readMig('20260815122000_pronunciation_text_curricular_identity.sql');

  it('replaces the 6-arg RPC with an 8-arg overload taking the curricular identity', () => {
    expect(sql).toMatch(/DROP FUNCTION IF EXISTS public\.create_pronunciation_training_text\(date, text, text, boolean, integer, boolean\)/);
    expect(sql).toMatch(/p_curriculum_version_id\s+uuid/);
    expect(sql).toMatch(/p_curriculum_subtopic_key\s+text/);
  });

  it('persists the identity IN THE SAME INSERT that creates the session', () => {
    expect(sql).toMatch(/INSERT INTO pronunciation_training_sessions[\s\S]*curriculum_version_id, curriculum_subtopic_key[\s\S]*VALUES[\s\S]*p_curriculum_version_id, p_curriculum_subtopic_key/);
  });

  it('returns the DURABLE identity so the caller never re-derives it', () => {
    expect(sql).toMatch(/'curriculumVersionId'/);
    expect(sql).toMatch(/'curriculumSubtopicKey'/);
  });

  it('re-grants the 8-arg signature to the same roles (never widens permissions)', () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.create_pronunciation_training_text\\(date, text, text, boolean, integer, boolean, uuid, text\\) TO ${role}`));
    }
  });
});

describe('pronunciation-training handler — identity is durable, not best-effort (ROOT-1)', () => {
  const handler = readFileSync(HANDLER, 'utf8');

  it('passes the resolved curricular identity into the atomic RPC', () => {
    expect(handler).toMatch(/create_pronunciation_training_text[\s\S]*p_curriculum_version_id:\s*resolvedPrompt\.versionId[\s\S]*p_curriculum_subtopic_key:\s*resolvedPrompt\.subtopicKey/);
  });

  it('no longer performs the best-effort post-RPC identity UPDATE', () => {
    // The removed block updated pronunciation_training_sessions only where
    // curriculum_subtopic_key IS NULL and swallowed failures under this tag.
    expect(handler).not.toMatch(/is\('curriculum_subtopic_key', null\)/);
    expect(handler).not.toMatch(/identity_persist_failed/);
  });

  it('checks the RPC { error } explicitly before delivering the session', () => {
    expect(handler).toMatch(/const \{ data: created, error: createError \} = await supabase\.rpc\('create_pronunciation_training_text'/);
    expect(handler).toMatch(/if \(createError\)/);
  });
});
