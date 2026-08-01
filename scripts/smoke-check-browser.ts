#!/usr/bin/env tsx
/**
 * CLI: real-browser smoke check — loads a URL in headless Chromium and fails
 * if the page throws an uncaught JS error, logs a console error, or never
 * renders visible content. Catches failures that a plain HTTP status check
 * cannot: the HTML shell can return 200 while the app itself crashes during
 * client-side init (e.g. a bad env var reaching the Supabase client).
 *
 * Usage:
 *   npx tsx scripts/smoke-check-browser.ts <url>
 */

import { chromium } from '@playwright/test';

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: npx tsx scripts/smoke-check-browser.ts <url>');
    process.exit(1);
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForTimeout(1_500);

  const body = await page.evaluate(() => ({
    height: document.body.offsetHeight,
    textLength: (document.body.innerText || '').trim().length,
  }));

  await browser.close();

  const failures: string[] = [];
  if (pageErrors.length > 0) {
    failures.push(`${pageErrors.length} uncaught JS error(s): ${pageErrors.join(' | ')}`);
  }
  if (consoleErrors.length > 0) {
    failures.push(`${consoleErrors.length} console.error call(s): ${consoleErrors.join(' | ')}`);
  }
  if (body.height === 0 || body.textLength === 0) {
    failures.push(`page rendered no visible content (body height=${body.height}, text length=${body.textLength})`);
  }

  if (failures.length > 0) {
    console.error(`Browser smoke check FAILED for ${url}:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log(`Browser smoke check passed for ${url} (no JS errors, content rendered).`);
}

main().catch((err) => {
  console.error('Browser smoke check crashed:', err);
  process.exit(1);
});
