-- ============================================================================
-- Permission seed: users.hard_delete (owner-only, MFA + recent-auth required).
-- ----------------------------------------------------------------------------
-- Highest-risk user operation (irreversible destruction of personal data +
-- removal from Supabase Auth). Modelled on gateway.emergency_stop /
-- settings.manage_high_risk / admins.promote_owner: owner role only,
-- requires_aal2 + requires_recent_auth so requireAdminPermission('users.hard_delete')
-- forces a verified MFA session and a recent re-auth before it can proceed.
-- Idempotent.
-- ============================================================================

-- Format note: keep the `INSERT INTO admin_permissions` keyword and the
-- `('users.hard_delete', ...)` row on their conventional shape — the
-- tests/security-permission-keys.test.ts consistency guard parses the seed
-- from exactly this pattern across every migration.
INSERT INTO admin_permissions (key, category, label, description, requires_aal2, requires_recent_auth) VALUES
  ('users.hard_delete', 'users', 'Excluir usuário definitivamente', 'Exclusão definitiva e irreversível de um usuário: remove todos os dados pessoais e de atividade, o vínculo com conteúdo compartilhado, objetos privados no Storage e a conta no Supabase Auth. Preserva apenas registros de supressão de comunicação (LGPD) e o log financeiro do RevenueCat.', true, true)
ON CONFLICT (key) DO UPDATE
  SET category = excluded.category,
      label = excluded.label,
      description = excluded.description,
      requires_aal2 = excluded.requires_aal2,
      requires_recent_auth = excluded.requires_recent_auth;

INSERT INTO admin_role_permissions (role, permission_key) VALUES
  ('owner', 'users.hard_delete')
ON CONFLICT (role, permission_key) DO NOTHING;
