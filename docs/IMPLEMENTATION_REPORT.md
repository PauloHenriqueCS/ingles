# Data-driven curriculum — implementation report

Branch `feature/data-driven-curriculum`, worktree `ingles-data-driven-curriculum`,
base `origin/main` = `125c45fabf641e80f023191b299f6c3e1a9d60fa`. NOT committed/pushed/merged.

## Validation
- `tsc -p tsconfig.json` → exit 0
- `tsc -p tsconfig.gateway.json` → exit 0
- `vite build` → exit 0
- `vitest run` (full) → 4263 passed / 2 failed; the 2 failures are the
  pre-existing `migrations_legacy/ai-gateway-budget-estimate-fix-migration-static`
  test, confirmed identical on the untouched main checkout. Zero regressions.
  (Count is 4263, down from an earlier 4270, because obsolete offline-catalog
  tests — GrammarTopicSheet-no-ai, calendar pedagogy — were removed with the code
  they covered.)

## Deploy-safety review flag (needs a human decision before merge/deploy)
Migration `20260815120500_listening_shared_stories_subtopic_aware.sql` does
`DROP FUNCTION` on the live 5-arg `acquire_or_get_listening_shared_story` and
creates an 8-arg replacement. CI applies migrations BEFORE the Vercel deploy, so
the currently-live code would call the dropped 5-arg signature during that window
→ transient listening-generation failures. It also diverges from the project's
"preserve RPC signature / no DROP of a live function" convention. Options to
consider: keep the 5-arg overload (don't DROP) for one release, or gate the
listening deploy. Left as-is (green + tested) for your review — do not merge
without deciding this.

## Diff shape
38 existing runtime/test files modified, 14 new paths. 1105 insertions /
1912 deletions (net removal of hardcoded English pedagogy).

## What changed
See docs/curriculum-engine.md. Foundation: generic schema + 176-recorte seed +
prompt-template seeds + pure engine (template/composer/progression/decision) +
server runtime (resolveActivityPrompt/recordCurricularPractice/ensureUserCurriculum,
post-C2 refinement) + curriculum endpoints (plan/preferences/progress) + Plano de
Ensino UI (macro only) + modality preferences. Consumers cut over: Writing,
Pronunciation, Listening, Conversation (guided/free), Review/Rewrite,
grammar-explanation. Legacy planner/diagnostic resolved to deprecated no-op stubs.

## Deploy note
Migrations are file-based (CI `db push`). This code is fail-loud on missing
curriculum config; it must ship in the SAME release that applies the 5 new
migrations. Do not commit/deploy code without migrations.
