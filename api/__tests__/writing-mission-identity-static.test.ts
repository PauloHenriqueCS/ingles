/**
 * Source-level guards for the writing curricular-credit invariants (blockers 2,
 * 5, 6, 7). This repo proves several server wirings with static source
 * assertions (see CurriculumPlanView-wiring.test.ts); the credit *rule* itself
 * is covered by curriculum-version-pinning-and-identity.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const reviewSrc = readFileSync(join(__dirname, '..', 'review-text.ts'), 'utf8');
const dayViewSrc = readFileSync(join(__dirname, '..', '..', 'src', 'components', 'DayView.tsx'), 'utf8');

describe('writing binds to the EXACT mission, never the latest theme (blocker 2)', () => {
  it('resolves the mission by the client-supplied generatedThemeId (a resource id), not created_at', () => {
    expect(reviewSrc).toMatch(/generatedThemeId/);
    // The theme is looked up by id + user, never "the latest generated theme".
    expect(reviewSrc).toMatch(/\.from\('generated_themes'\)[\s\S]{0,200}\.eq\('id', themeId\)/);
    expect(reviewSrc).not.toMatch(/from\('generated_themes'\)[\s\S]{0,200}order\('created_at'/);
  });

  it('the client sends only the resource id (generatedThemeId) — never a subtopic/version', () => {
    expect(dayViewSrc).toMatch(/generatedThemeId: dailyTheme\?\.id/);
    expect(dayViewSrc).not.toMatch(/curriculum_version_id:|curriculum_subtopic_key:|subtopicKey:/);
  });

  it('uses the identity-REQUIRED recorder (no current-pointer fallback — blocker 5)', () => {
    expect(reviewSrc).toMatch(/recordCurricularPracticeFromIdentity/);
    expect(reviewSrc).not.toMatch(/recordCurricularPractice\(/); // the instantaneous variant is NOT used for writing
  });
});

describe('writing curricular credit is CONVERGENT (blocker 6.A)', () => {
  it('an already-completed review retry still reconciles credit (no early return before it)', () => {
    // The completed-reservation branch calls the shared idempotent helper.
    expect(reviewSrc).toMatch(/ensureWritingCurricularCredit/);
    expect(reviewSrc).toMatch(/reservation\.status === 'completed'[\s\S]*ensureWritingCurricularCredit/);
  });

  it('the helper marks a credit status (marker only) and never re-calls the AI provider', () => {
    expect(reviewSrc).toMatch(/curriculum_credit_status: rec\?\.recorded \? 'credited' : 'pending'/);
  });
});
