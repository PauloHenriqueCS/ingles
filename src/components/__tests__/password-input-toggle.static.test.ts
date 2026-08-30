/**
 * Show/hide password toggle. jsdom is not configured in this repo
 * (vite.config runs in the node environment), so the PasswordInput behaviour
 * is verified via static-wiring assertions per the repo convention (see
 * subscription-legal-links.static.test.ts). We assert the exact guarantees the
 * feature promises: the field starts hidden, the toggle only swaps the input
 * type, it never submits the form, and it carries the correct accessible label.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const componentsDir = join(__dirname, '..');
const passwordInput = readFileSync(join(componentsDir, 'PasswordInput.tsx'), 'utf8');
const loginPage = readFileSync(join(componentsDir, 'LoginPage.tsx'), 'utf8');
const resetPage = readFileSync(join(componentsDir, 'ResetPasswordPage.tsx'), 'utf8');

describe('PasswordInput — visibility toggle wiring', () => {
  it('defaults to hidden (visible state starts false → type="password")', () => {
    expect(passwordInput).toContain('useState(false)');
    expect(passwordInput).toMatch(/type=\{visible \? 'text' : 'password'\}/);
  });

  it('toggles visibility on click without altering the value', () => {
    // Only the boolean flips; the input value/onChange are forwarded untouched.
    expect(passwordInput).toMatch(/onClick=\{\(\) => setVisible\(\(v\) => !v\)\}/);
    expect(passwordInput).toContain('{...inputProps}');
  });

  it('the toggle is a non-submitting button (type="button")', () => {
    const buttonIdx = passwordInput.indexOf('<button');
    expect(buttonIdx).toBeGreaterThanOrEqual(0);
    const buttonTag = passwordInput.slice(buttonIdx, passwordInput.indexOf('>', buttonIdx));
    expect(buttonTag).toContain('type="button"');
  });

  it('exposes a state-correct aria-label for accessibility', () => {
    expect(passwordInput).toMatch(/aria-label=\{visible \? 'Ocultar senha' : 'Mostrar senha'\}/);
  });

  it('reuses the existing lucide-react icon set (no new icon dependency)', () => {
    expect(passwordInput).toMatch(/import \{ Eye, EyeOff \} from 'lucide-react'/);
  });

  it('reserves right padding so the value never runs under the icon (no layout shift)', () => {
    expect(passwordInput).toContain('pr-12');
    // The toggle is absolutely positioned inside a relative wrapper, so
    // swapping the icon cannot change the input's height or width.
    expect(passwordInput).toContain('className="relative"');
    expect(passwordInput).toContain('absolute inset-y-0 right-0');
  });
});

describe('auth forms adopt the shared PasswordInput', () => {
  it('LoginPage uses PasswordInput for the login/signup password field', () => {
    expect(loginPage).toContain("import PasswordInput from './PasswordInput'");
    expect(loginPage).toContain('<PasswordInput');
    // The raw type="password" input is fully replaced.
    expect(loginPage).not.toContain('type="password"');
  });

  it('ResetPasswordPage uses PasswordInput for both new + confirm fields', () => {
    expect(resetPage).toContain("import PasswordInput from './PasswordInput'");
    expect(resetPage.match(/<PasswordInput/g)?.length).toBe(2);
    expect(resetPage).not.toContain('type="password"');
  });
});
