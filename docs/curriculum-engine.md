# Data-driven curriculum engine — architecture & wiring plan

This document describes the generic, language-agnostic curriculum engine added on
branch `feature/data-driven-curriculum`, and the plan to cut the live activities
over to it.

## Goal

Turn Orodim from an English-coupled app into a **generic learning engine** where
all pedagogical knowledge lives in the database, versioned by
`(learning_language, curriculum_version)`. The acceptance test: *registering a
full Spanish curriculum tomorrow must require no Spanish-specific pedagogical
logic in code.*

## Two languages, always distinct

- `learning_language` — the language the user is **learning** (`en`, `es`, ...).
- `interface_language` — the language of **UI / instructions / explanations**
  (`pt-BR`, `en`, ...).

Neither is assumed anywhere in the engine. The only product-level bootstrap
default (`en` / `pt-BR`) lives at the composition edge in the consumers, as
product config — never pedagogical knowledge.

## Data model (migration `20260815120000`)

Structural entities are separated from localized content (`*_i18n`):

```
languages
proficiency_frameworks → proficiency_levels
curricula → curriculum_versions
curriculum_modules (+ _i18n)          ← visible to the user (macro)
curriculum_subtopics (+ _i18n)        ← RECORTES, internal, never shown as IDs
curriculum_language_targets           ← "Suporte linguístico" of a recorte
curriculum_transversal_topics (+_i18n)← not in the mandatory sequence
prompt_templates                      ← runtime prompts, per (learn, iface) lang
level_generation_rules                ← declarative jsonb (word counts, budgets…)
user_curriculum_preferences           ← selected modalities (menu = rule)
user_curriculum_progress              ← level/module/subtopic position + status
user_subtopic_modality_progress       ← one valid practice per (user,recorte,modality)
user_subtopic_completion              ← derived: all selected modalities practised
```

IDs are stable and semantic (`B1.OPINION.AGREE_DISAGREE`); order lives in
`sort_order`, never in the ID.

## Seed (migrations `20260815120100`, `20260815120200`)

`20260815120100_seed_curriculum_english_v1.sql` is **generated** from
`supabase/curriculum_source/*.md` by
`scripts/curriculum/generate-curriculum-seed.mjs` — re-run the script to
regenerate. It loads the English V1 curriculum: 6 levels, 48 modules, **176
recortes**, 6 transversal topics, `interface_language = pt-BR`.

`20260815120200_seed_prompt_templates_english_v1.sql` loads real, parameterized
prompt templates for `(en, pt-BR)` for `writing.generate_topic`,
`pronunciation.generate_text`, `listening.two_part_generate`,
`conversation.tutor`. Adding another language = inserting rows with a different
`(learning_language, interface_language)` — no code change.

## Engine (pure, `src/domain/curriculum-engine/`)

- `types.ts` — generic types (no English, no CEFR names baked in).
- `language-context.ts` — `LanguageContext` + resolution.
- `template-engine.ts` — safe `{{placeholder}}` interpolation, no `eval`;
  missing placeholder / empty required value → explicit error.
- `prompt-composer.ts` — `template + language + level rule + module + subtopic +
  targets + user context → final prompt`. No pedagogical content; no English
  fallback.
- `progression.ts` — recorte completion = all **selected** modalities practised;
  module/level/curriculum completion; recompute on preference change.
- `curriculum-repository.ts` — data-access port + `SupabaseCurriculumRepository`.
- `resolve-curriculum-prompt.ts` — the seam the API endpoints call.

## Wiring status — CUT OVER (runtime now DB-sourced)

All curricular generation/feedback consumers were cut over to the engine and the
hardcoded prompts were removed from those runtime paths (see below). Both
typechecks pass and the full test suite is green except one pre-existing
`migrations_legacy` static test unrelated to this work.

> **Deploy-ordering caveat (still applies).** The seed data reaches a database
> only when these migration files are applied by CI (`db push`) on merge/deploy.
> The deploy pipeline applies migrations (step 4) BEFORE the Vercel deploy (step
> 6), so by the time this code is live the tables/templates exist. The runtime is
> intentionally fail-loud: `resolveActivityPrompt` throws `CurriculumConfigError`
> (→ 503 `CURRICULUM_NOT_CONFIGURED`) if the curriculum/template is missing —
> never a silent hardcoded English fallback. Do NOT deploy this code without the
> migrations in the same release.

### What was cut over
- Writing generation → `writing.generate_topic`; correction → `writing.correct` /
  `writing.correct_review`; records `writing` practice on successful review.
- Pronunciation text → `pronunciation.generate_text`; records `pronunciation`.
- Listening story → `listening.two_part_generate` (recorte-aligned); records
  `listening` on consume. (Cache key still group-level — see TODO in
  generate-listening-story.ts.)
- Conversation guided mode → `conversation.tutor`; records `conversation` on a
  validly-completed guided session. Free mode retained, de-hardcoded language.
- Review/Rewrite → `writing.compare_rewrite` / `writing.correct_v2_text` /
  `writing.evaluate_rewrite` / `writing.explain_grammar` (non-curricular; no
  practice recorded).
- Legacy planner/diagnostic: removed from the live path; api/_mission-*/_diagnostic-*
  reduced to loud `@deprecated` stubs (no writes to missing tables).

### Later cutover (a concurrent continuation, re-validated: green)
- Listening shared-story cache is now subtopic-aware (migration
  `20260815120500`): `(learning_language, level_group, subtopic_key,
  practice_date, slot)` unique + rewritten `acquire_or_get_listening_shared_story`
  (8-arg). Legacy `listening_episodes` inventory no longer selected for new
  practice (`empty_inventory` → Story path); `on-demand/*` and `group/*` routes
  return HTTP 410. **See the DROP FUNCTION deploy-safety flag in
  IMPLEMENTATION_REPORT.md.**
- Frontend pedagogical cutover: `GrammarHelpModal` uses the `/api/grammar-explanation`
  endpoint only; `GrammarTopicSheet` (offline `legacy-grammar-aliases`) removed,
  MemoryView uses the data-driven modal; `calendar2026` reduced to scheduling/date
  helpers (`MONTH_GRAMMAR`/`MONTH_LEVEL`/topic lists/`ALL_VERB_TENSES` removed);
  `DayView` takes theme/objective/level from the curriculum mission, not the
  calendar.

### Still remaining (deferred / out of scope)
- `english_*` table/type renames (non-blocking: learning_language is carried in
  the new curriculum tables; existing data preserved).
- Placement/promotion (`promotionEvidenceCollector` → `GRAMMAR_CATALOG`) — the
  spec explicitly defers the placement test; documented survivor.
- Runtime-orphaned domain modules (grammar-catalog, communicative-objectives,
  mission-fallback, diagnostic-objectives, plan-writing-mission) are now test-only
  dead code; safe to delete in a follow-up.

For each of Writing / Pronunciation / Listening / Conversation:

1. Resolve `LanguageContext` (from `user_curriculum_preferences`, bootstrap
   default `en`/`pt-BR`).
2. Resolve the user's `current_subtopic` via `user_curriculum_progress`.
3. Call `resolveCurriculumPrompt({ repository, languageContext, templateKey,
   activityType, subtopicKey })` to obtain `{ system, user, model, temperature }`.
4. Send to the provider through the existing AI Gateway.
5. On a valid, completed practice, record
   `user_subtopic_modality_progress`, recompute completion, advance progress —
   via a server-authoritative RPC (to add, mirroring
   `consume_listening_pending_story`).

Consumers to change (see the audit): `api/generate-theme.ts`,
`api/pronunciation-training/[...slug].ts`,
`src/services/listening/story-session/generate-listening-story.ts`,
`api/conversation/[...slug].ts` + `src/lib/promptBuilder.ts`.

Hardcodes to delete **in the deploy release** (once templates are live):
`src/domain/curriculum/topics/*`, `src/lib/grammarContent.ts`,
`src/domain/pedagogy/planner/communicative-objectives.ts`,
`src/domain/missions/mission-fallback.ts`, `src/data/calendar2026.ts`
(as curriculum authority), the `LEVEL_INSTRUCTIONS`/`LEVEL_GUIDE`/`CEFR_RULES`
inline rubrics.

## Legacy planner

Resolve (do not leave "half-alive"): the flag-on planner in `api/generate-theme.ts`
should be replaced by `resolveCurriculumPrompt`, and the legacy
`mission_pedagogical_plans` / `learner_grammar_*` write attempts removed. Do NOT
apply `migrations_legacy` (that would "arm" the current planner to persist).
