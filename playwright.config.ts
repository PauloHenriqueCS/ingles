import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '.env') });

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const API_BASE  = process.env.E2E_API_BASE  ?? BASE_URL;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],

  timeout:       60_000,
  expect:        { timeout: 10_000 },

  use: {
    baseURL:           BASE_URL,
    trace:             'on-first-retry',
    screenshot:        'only-on-failure',
    video:             'retain-on-failure',
    actionTimeout:     15_000,
    navigationTimeout: 30_000,
    locale:            'pt-BR',
  },

  projects: [
    // ── Node-only (no browser): baseline, security static ──────────────────
    {
      name: 'node-checks',
      testMatch: ['**/01-baseline.spec.ts', '**/02-security-static.spec.ts'],
    },

    // ── Chrome desktop: recorder, api, accessibility ───────────────────────
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--use-fake-audio-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
        permissions: ['microphone'],
        contextOptions: {
          permissions: ['microphone'],
        },
      },
      testMatch: [
        '**/03-recorder-mocked.spec.ts',
        '**/04-api-integration.spec.ts',
        '**/08-accessibility.spec.ts',
        '**/09-dashboard.spec.ts',
        '**/10-calendar.spec.ts',
        '**/11-smoke.spec.ts',
      ],
    },

    // ── Credential-gated: RLS, concurrency, real Azure ─────────────────────
    {
      name: 'chromium-authenticated',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--use-fake-audio-for-media-stream',
            '--use-fake-ui-for-media-stream',
          ],
        },
        permissions: ['microphone'],
      },
      testMatch: [
        '**/05-rls.spec.ts',
        '**/06-concurrency.spec.ts',
        '**/07-azure-real.spec.ts',
      ],
    },
  ],

  // Start local dev server for browser tests
  webServer: {
    command: 'npm run dev -- --port 5173',
    url:     'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});

export { BASE_URL, API_BASE };
