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

/**
 * Blanks out the contents of string literals (keeping the quotes) so the
 * logging-safety checks below match real code — a bare `token`/`authorization`
 * identifier being passed as a log argument — instead of the words appearing
 * incidentally inside a log message's own text, e.g. "Unexpected token error"
 * or "Authorization check failed" are not a credential being logged.
 */
function stripStringLiterals(src: string): string {
  return src.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, (m) => `${m[0]}${m[0]}`);
}

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
  // api/pronunciation/{start,complete,fail,status}.ts were consolidated into
  // a single [...slug].ts catch-all dispatcher (Vercel Hobby plan's
  // 12-function cap — see api/conversation/ and api/listening/ for the same
  // pattern repo-wide). Resolve whichever shape actually exists on disk
  // instead of hardcoding paths that silently go stale on the next
  // reorganization; fail with a clear message (not a bare ENOENT) if
  // neither shape is found.
  function resolvePronunciationHandlerFiles(): string[] {
    const dir = path.join(ROOT, 'api/pronunciation');
    const consolidated = path.join(dir, '[...slug].ts');
    if (fs.existsSync(consolidated)) return [consolidated];

    const individual = ['start.ts', 'complete.ts', 'fail.ts', 'status.ts'].map(f => path.join(dir, f));
    const missing = individual.filter(f => !fs.existsSync(f));
    if (missing.length > 0) {
      throw new Error(
        `Could not find the pronunciation API handler(s) to inspect. Expected either ` +
        `${consolidated} or all of: ${individual.join(', ')}. Missing: ${missing.join(', ')}. ` +
        `Update this resolver in tests/e2e/02-security-static.spec.ts to match the current api/pronunciation/ structure.`
      );
    }
    return individual;
  }

  test('pronunciation start handler uses Cache-Control: no-store for the token response', () => {
    for (const file of resolvePronunciationHandlerFiles()) {
      expect(fs.readFileSync(file, 'utf8')).toContain('no-store');
    }
  });

  test('pronunciation complete handler uses Cache-Control: no-store', () => {
    for (const file of resolvePronunciationHandlerFiles()) {
      expect(fs.readFileSync(file, 'utf8')).toContain('no-store');
    }
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

  test('pronunciation handlers do not log Authorization header or full token', () => {
    for (const file of resolvePronunciationHandlerFiles()) {
      const src = stripStringLiterals(fs.readFileSync(file, 'utf8'));
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
