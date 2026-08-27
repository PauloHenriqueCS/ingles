/**
 * Source-level guards for the `mode: 'discard'` branch of api/generate-theme.ts,
 * used by the writing flow's "Nova missão" durable reset. It must supersede the
 * user's active mission (mark 'regenerated') so a later `mode: 'retrieve'`
 * returns nothing — WITHOUT an AI call, WITHOUT inserting a row, and WITHOUT
 * refunding a generation (the daily counter counts rows created today regardless
 * of status).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, '..', 'generate-theme.ts'), 'utf8');

function discardBlock(): string {
  const start = src.indexOf("req.body?.mode === 'discard'");
  expect(start, 'discard branch not found').toBeGreaterThan(-1);
  // slice a generous window covering the branch body
  return src.slice(start, start + 700);
}

describe("generate-theme — mode: 'discard' (Nova missão durable reset)", () => {
  it('marks the active mission(s) as regenerated, scoped to the user and current day', () => {
    const b = discardBlock();
    expect(b).toMatch(/\.from\('generated_themes'\)/);
    expect(b).toMatch(/\.update\(\{ status: 'regenerated' \}\)/);
    expect(b).toMatch(/\.eq\('user_id', userId\)/);
    expect(b).toMatch(/\.eq\('status', 'generated'\)/);
    expect(b).toMatch(/utcDayRange/);
  });

  it('is a pure supersede: no AI call and no insert in the branch', () => {
    const b = discardBlock();
    expect(b).not.toMatch(/executeAiGatewayCall|\.insert\(/);
  });

  it('returns a lightweight ack', () => {
    const b = discardBlock();
    expect(b).toMatch(/res\.json\(\{ ok: true, mode: 'discard' \}\)/);
  });
});
