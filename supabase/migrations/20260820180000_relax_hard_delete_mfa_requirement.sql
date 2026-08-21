-- ============================================================================
-- Relax the MFA (AAL2) requirement on users.hard_delete.
-- ----------------------------------------------------------------------------
-- The owner account operating the admin has no TOTP authenticator enrolled, so
-- every hard delete was blocked with AAL2_REQUIRED. Per the owner's explicit
-- decision (2026-08-20) we drop the AAL2 gate on this action.
--
-- We deliberately KEEP requires_recent_auth = true so this irreversible action
-- still demands a fresh login as a lightweight residual guard.
--
-- Must run AFTER 20260820123000_users_hard_delete_permission.sql, whose
-- `ON CONFLICT DO UPDATE ... requires_aal2 = excluded.requires_aal2` re-asserts
-- true on every apply. This UPDATE is the authoritative later state.
--
-- Idempotent: safe to re-run; no-op if the row is absent.
-- ============================================================================

UPDATE admin_permissions
SET requires_aal2 = false
WHERE key = 'users.hard_delete';
