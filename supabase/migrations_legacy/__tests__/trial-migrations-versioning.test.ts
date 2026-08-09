/**
 * Versioning assertions for the Etapa 2A trio — no live database connection
 * here. Confirms the three files' timestamps are globally unique (never
 * colliding with anything known locally or already applied to
 * lemon-homolog) and preserve the required application order.
 *
 * Known collision sources checked against (all confirmed read-only, no
 * writes, via the Supabase MCP list_migrations tool and by reading the
 * neighboring ingles-dashboad checkout):
 *   - lemon-homolog's supabase_migrations.schema_migrations: highest known
 *     version 20260727223126 (ingles-dashboad's
 *     trial_plan_and_capability_reconciliation, applied via a path other
 *     than a local-file db push — see supabase/MIGRATIONS.md's
 *     "Coordenação com ingles-dashboad" section).
 *   - ingles-dashboad's own local supabase/migrations/ directory: highest
 *     filename 20260727000000_trial_plan_and_capability_reconciliation.sql.
 *   - the "ingles" production project's own schema_migrations: highest
 *     version 20260724105536 (well below any candidate here).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'fs';
import { resolve } from 'path';

// The Etapa 2A trio was promoted from migrations_legacy/ into the active
// supabase/migrations/ directory — assert against where the files actually
// live now (this test file itself stays archived here).
const MIGRATIONS_DIR = resolve(__dirname, '..', '..', 'migrations');
const ALL_MIGRATION_FILES = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));

const TRIAL_FILES = [
  '20260727224000_conversation_trial_total_capability_definitions.sql',
  '20260727224100_publish_plan_version_trial_total_capability.sql',
  '20260727224200_authorize_trial_conversation_session.sql',
];

// The highest version known to be already present in lemon-homolog's
// supabase_migrations.schema_migrations at the time of this revision
// (confirmed via list_migrations, read-only).
const KNOWN_REMOTE_MAX_VERSION = '20260727223126';
// Known local filename in the neighboring ingles-dashboad checkout that
// must never collide with any file in this repository.
const KNOWN_DASHBOARD_LOCAL_VERSION = '20260727000000';

describe('Etapa 2A trial migrations — versioning', () => {
  it('all three files exist in supabase/migrations/', () => {
    for (const file of TRIAL_FILES) {
      expect(ALL_MIGRATION_FILES).toContain(file);
    }
  });

  it('preserves the required order: capability definitions → publish_plan_version → atomic authorization', () => {
    const versions = TRIAL_FILES.map((f) => f.slice(0, 14));
    const sorted = [...versions].sort();
    expect(versions).toEqual(sorted);
  });

  it('every version is strictly greater than the highest known REMOTE version already applied to lemon-homolog', () => {
    for (const file of TRIAL_FILES) {
      const version = file.slice(0, 14);
      expect(version > KNOWN_REMOTE_MAX_VERSION).toBe(true);
    }
  });

  it('no version collides with the known ingles-dashboad local filename', () => {
    for (const file of TRIAL_FILES) {
      const version = file.slice(0, 14);
      expect(version).not.toBe(KNOWN_DASHBOARD_LOCAL_VERSION);
    }
  });

  it('no version collides with any OTHER file already in this repository\'s supabase/migrations/', () => {
    const otherVersions = ALL_MIGRATION_FILES
      .filter((f) => !TRIAL_FILES.includes(f))
      .map((f) => f.slice(0, 14));
    for (const file of TRIAL_FILES) {
      const version = file.slice(0, 14);
      expect(otherVersions).not.toContain(version);
    }
  });

  it('the three versions are pairwise distinct', () => {
    const versions = TRIAL_FILES.map((f) => f.slice(0, 14));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('no migration is dated artificially in the future relative to today (2026-07-27)', () => {
    const TODAY = '20260727';
    for (const file of TRIAL_FILES) {
      const datePart = file.slice(0, 8);
      expect(datePart <= TODAY).toBe(true);
    }
  });
});
