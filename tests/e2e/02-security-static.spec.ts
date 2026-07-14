/**
 * SECTION 11 — SECURITY (static / bundle inspection)
 *
 * Inspects the compiled dist/ bundle to verify that no secrets are embedded.
 * Verifies API response headers for Cache-Control: no-store on token endpoints.
 *
 * Runs in node project (no browser needed). Requires `npm run build` first.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const ROOT   = path.resolve(__dirname, '../..');
const DIST   = path.join(ROOT, 'dist');

function readAllJsInDist(): string {
  if (!fs.existsSync(DIST)) return '';
  const files = fs.readdirSync(path.join(DIST, 'assets')).filter(f => f.endsWith('.js'));
  return files.map(f => fs.readFileSync(path.join(DIST, 'assets', f), 'utf8')).join('\n');
}

test.describe('Security — bundle inspection', () => {
  test.beforeAll(() => {
    if (!fs.existsSync(DIST)) {
      execSync('npm run build', { cwd: ROOT, timeout: 120_000 });
    }
  });

  test('AZURE_SPEECH_KEY is not present in the browser bundle', () => {
    const bundle = readAllJsInDist();
    // Check for the literal env var name or typical key patterns
    expect(bundle).not.toContain('AZURE_SPEECH_KEY');
    // Azure cognitive keys are 32-char hex (test pattern only — not real key)
    // We check the variable name is absent, not the value
  });

  test('NEXT_PUBLIC_AZURE prefix is absent (no accidental client exposure)', () => {
    const bundle = readAllJsInDist();
    expect(bundle).not.toContain('NEXT_PUBLIC_AZURE');
  });

  test('AZURE_SPEECH_REGION env var name is absent from browser bundle', () => {
    const bundle = readAllJsInDist();
    // The server-only region env var must not be bundled
    expect(bundle).not.toContain('AZURE_SPEECH_REGION');
  });

  test('SUPABASE_SERVICE_ROLE_KEY is absent from browser bundle', () => {
    const bundle = readAllJsInDist();
    expect(bundle).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  test('OPENAI_API_KEY is absent from browser bundle', () => {
    const bundle = readAllJsInDist();
    expect(bundle).not.toContain('OPENAI_API_KEY');
  });

  test('ANTHROPIC_API_KEY is absent from browser bundle', () => {
    const bundle = readAllJsInDist();
    expect(bundle).not.toContain('ANTHROPIC_API_KEY');
  });

  test('No process.env reference for secrets in browser bundle', () => {
    const bundle = readAllJsInDist();
    // These env vars must only exist in server-side api/ code, never in Vite bundle
    expect(bundle).not.toMatch(/process\.env\.AZURE_SPEECH/);
    expect(bundle).not.toMatch(/process\.env\.OPENAI/);
    expect(bundle).not.toMatch(/process\.env\.SUPABASE_SERVICE/);
  });

  test('api/_azure-speech module is NOT imported in browser bundle', () => {
    const bundle = readAllJsInDist();
    // The server-only file should never appear in the Vite bundle
    expect(bundle).not.toContain('_azure-speech');
    expect(bundle).not.toContain('issueAzureSpeechToken');
  });

  test('Vite VITE_ prefix enforced: only VITE_ vars in bundle env references', () => {
    const bundle = readAllJsInDist();
    // import.meta.env references in bundle should only be VITE_ prefixed
    const nonViteRefs = bundle.match(/import\.meta\.env\.[A-Z][A-Z_]*/g) ?? [];
    const forbidden   = nonViteRefs.filter(r => !r.startsWith('import.meta.env.VITE_'));
    expect(forbidden).toHaveLength(0);
  });

  test('dist/ contains no .env file', () => {
    if (!fs.existsSync(DIST)) return;
    const files = fs.readdirSync(DIST);
    expect(files.some(f => f.startsWith('.env'))).toBe(false);
  });

  test('dist/ contains no private key file (*.pem, *.key)', () => {
    if (!fs.existsSync(DIST)) return;
    const walk = (dir: string): string[] => {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      return items.flatMap(i =>
        i.isDirectory() ? walk(path.join(dir, i.name)) : [path.join(dir, i.name)],
      );
    };
    const files = walk(DIST);
    const keys = files.filter(f => f.endsWith('.pem') || f.endsWith('.key'));
    expect(keys).toHaveLength(0);
  });
});

test.describe('Security — API handler source inspection', () => {
  test('api/pronunciation/start.ts uses Cache-Control: no-store for token response', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'api/pronunciation/start.ts'), 'utf8'
    );
    expect(src).toContain('no-store');
  });

  test('api/pronunciation/complete.ts uses Cache-Control: no-store', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'api/pronunciation/complete.ts'), 'utf8'
    );
    expect(src).toContain('no-store');
  });

  test('api/_azure-speech.ts has no VITE_ prefix on secret vars', () => {
    const src = fs.readFileSync(path.join(ROOT, 'api/_azure-speech.ts'), 'utf8');
    expect(src).not.toContain('VITE_AZURE');
    expect(src).not.toContain('NEXT_PUBLIC_AZURE');
  });

  test('Azure token is obtained from env, not hardcoded', () => {
    const src = fs.readFileSync(path.join(ROOT, 'api/_azure-speech.ts'), 'utf8');
    // Must read from process.env, not a literal string
    expect(src).toContain('process.env.AZURE_SPEECH_KEY');
  });

  test('api/ handlers do not log Authorization header or full token', () => {
    const handlers = [
      'api/pronunciation/start.ts',
      'api/pronunciation/complete.ts',
      'api/pronunciation/fail.ts',
      'api/pronunciation/status.ts',
    ].map(f => fs.readFileSync(path.join(ROOT, f), 'utf8'));

    for (const src of handlers) {
      // Must not log the Authorization header
      expect(src).not.toMatch(/console\.\w+\(.*[Aa]uthorization/);
      // Must not log raw tokens
      expect(src).not.toMatch(/console\.\w+\(.*token/);
    }
  });

  test('requireAuth extracts token from header, never from body/query', () => {
    const src = fs.readFileSync(path.join(ROOT, 'api/_auth.ts'), 'utf8');
    expect(src).toContain("req.headers['authorization']");
    expect(src).not.toContain('req.query.token');
    expect(src).not.toContain('req.body.token');
  });
});
