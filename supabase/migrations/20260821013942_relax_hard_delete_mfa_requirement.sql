-- Relax the AAL2 (MFA) requirement on the users.hard_delete admin permission.
--
-- RECONCILIATION FILE — read this before assuming it is a normal migration.
--
-- This change was applied DIRECTLY to the production database on
-- 2026-08-21 01:39:42 UTC (recorded in supabase_migrations.schema_migrations as
-- version 20260821013942, name relax_hard_delete_mfa_requirement) without a
-- corresponding file in this repository. That left `supabase db push` unable to
-- run at all — it aborts with:
--
--     Remote migration versions not found in local migrations directory.
--
-- which blocked EVERY production deploy (not just the change that happened to
-- be in flight). This file restores the invariant that the migrations directory
-- is a faithful record of what has been applied. Its body is reproduced
-- verbatim from that recorded migration's single statement, so it is a true
-- reconstruction, not a re-interpretation.
--
-- Effect per environment:
--   * production — version 20260821013942 is ALREADY in the remote migration
--     history, so db push treats it as applied and re-runs nothing. This file
--     is pure bookkeeping there.
--   * homologation — the version was never applied, so this DOES run and aligns
--     homolog with production (deliberate: the two environments should not
--     disagree on an admin permission's MFA requirement).
--
-- The statement is idempotent: re-running it sets an already-false column to
-- false and matches zero-or-one row.
--
-- Reminder for future changes: migrations are FILES applied by CI (`db push`).
-- Applying SQL straight to a database (e.g. via the MCP apply_migration tool)
-- desynchronizes the history and breaks deploys exactly as it did here.

UPDATE admin_permissions
SET requires_aal2 = FALSE
WHERE key = 'users.hard_delete';
