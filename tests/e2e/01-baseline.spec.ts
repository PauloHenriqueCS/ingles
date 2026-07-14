/**
 * SECTION 1 — BASELINE
 *
 * Validates that unit tests, TypeScript, and build all pass before consuming
 * any Azure quota or real backend calls.
 *
 * Runs in node project (no browser needed).
 */
import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const EXEC = (cmd: string) => execSync(cmd, { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });

test.describe('Baseline — unit tests, TypeScript, build', () => {
  test('vitest: all unit tests pass', () => {
    const out = EXEC('npm run test -- --reporter=verbose 2>&1');
    // vitest exits 0 on success; if it throws, the test fails
    expect(out).toContain('passed');
    expect(out).not.toMatch(/\d+ failed/);
  });

  test('TypeScript: tsc --noEmit is clean', () => {
    // tsc exits 0 on success; any error throws and fails this test
    EXEC('npx tsc --noEmit');
    // If we reach here, tsc passed
    expect(true).toBe(true);
  });

  test('build: vite build completes without errors', () => {
    const out = EXEC('npm run build 2>&1');
    // The build may warn about Azure SDK chunk size — that is pre-existing and acceptable
    const hasError = /error TS\d+|Error:|failed to/i.test(out) &&
                     !out.includes('(!) Some chunks are larger than');
    expect(hasError).toBe(false);
  });
});
