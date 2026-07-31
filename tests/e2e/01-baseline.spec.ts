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
// maxBuffer default is 1 MB — the growing suite's --reporter=verbose output
// now exceeds that on its own (ENOBUFS), independent of whether the tests
// themselves pass or fail. 64 MB is a generous ceiling for stdout+stderr.
const EXEC = (cmd: string) => execSync(cmd, { cwd: ROOT, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });

test.describe('Baseline — unit tests, TypeScript, build', () => {
  test('vitest: all unit tests pass', () => {
    const out = EXEC('npm run test -- --reporter=verbose 2>&1');
    // vitest exits 0 on success; if it throws, the test fails.
    expect(out).toContain('passed');
    // Match only vitest's own "Tests  N failed | ..." summary line, not any
    // incidental "N failed" substring elsewhere in the verbose output — a
    // real, currently-passing test is named "throws StoryParseError after 3
    // failed block 1 parse attempts", which the previous bare /\d+ failed/
    // pattern matched regardless of whether anything actually failed.
    expect(out).not.toMatch(/\bTests\s+\d+ failed\b/);
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
