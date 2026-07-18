/**
 * Static source assertions on scripts/ai-gateway-enforce-preflight.ts —
 * Etapa 11, Fase 16 — operational correction.
 *
 * The script itself isn't imported here: it exits the process at module
 * scope when VITE_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are unset (correct
 * CLI ergonomics, out of scope for this correction), so pulling it into a
 * Vitest process is the wrong tool. Its actual readiness LOGIC already has
 * full behavioral coverage via api/__tests__/enforce-readiness.test.ts,
 * which computeFeatureReadiness is imported from verbatim (see the shared
 * import block in the script) — not duplicated. What's specific to the CLI
 * script and worth asserting from its source text is the negative property
 * the user asked for: no hardcoded MIGRATION_APPLIED_REMOTELY/
 * CONCURRENCY_VALIDATED boolean, ever — infraDeployed and
 * concurrencyValidated must always trace back to a live probe/query call.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const SCRIPT_PATH = resolve(__dirname, '..', '..', 'scripts', 'ai-gateway-enforce-preflight.ts');
const src = readFileSync(SCRIPT_PATH, 'utf8');

describe('scripts/ai-gateway-enforce-preflight.ts — no hardcoded readiness booleans', () => {
  it('never declares a hardcoded MIGRATION_APPLIED_REMOTELY constant', () => {
    expect(src).not.toMatch(/MIGRATION_APPLIED_REMOTELY/);
  });

  it('never declares a hardcoded CONCURRENCY_VALIDATED constant', () => {
    expect(src).not.toMatch(/\bCONCURRENCY_VALIDATED\s*=/);
  });

  it('infraDeployed is always assigned from the live probeInfra() result, never a literal', () => {
    expect(src).toMatch(/const infraDeployed = infra\.rateLimit && infra\.dedupe && infra\.reservation && infra\.breaker && infra\.concurrencyLog;/);
  });

  it('concurrencyValidated is always assigned from the live checkConcurrencyValidated() result, never a literal', () => {
    expect(src).toMatch(/const concurrency = await checkConcurrencyValidated\(supabase\);/);
    expect(src).toMatch(/concurrency\.validated/);
  });

  it('checkConcurrencyValidated queries the live ai_gateway_concurrency_validations table by the live-computed script hash and current migration version — never assumes a match', () => {
    expect(src).toMatch(/\.from\('ai_gateway_concurrency_validations'\)/);
    expect(src).toMatch(/\.eq\('migration_version', MIGRATION_VERSION\)/);
    expect(src).toMatch(/\.eq\('validation_script_sha256', scriptHash\)/);
  });

  it('the readiness computation itself is imported from the shared pure module, not reimplemented inline in the script', () => {
    expect(src).toMatch(/import\s*\{[^}]*computeFeatureReadiness[^}]*\}\s*from\s*'\.\.\/api\/_ai-gateway\/enforce-readiness'/s);
  });

  it('main() is guarded so importing this module never fires a live Supabase call as a side effect', () => {
    expect(src).toMatch(/if \(require\.main === module\) \{/);
  });
});
