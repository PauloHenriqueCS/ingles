/**
 * Static SQL-text assertions for
 * 20260812220000_gpt4o_mini_tts_preview_pricing.sql — no live DB. Registers the
 * pricing catalog row for the new voice-preview model. Must be additive and
 * idempotent, and must not alter any existing price.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const sql = readFileSync(resolve(__dirname, '..', '20260812220000_gpt4o_mini_tts_preview_pricing.sql'), 'utf8');
const executableSql = sql.split('\n').map((l) => (l.trim().startsWith('--') ? '' : l)).join('\n');

describe('20260812220000 — gpt-4o-mini-tts preview pricing', () => {
  it('inserts a pricing row for openai/audio.speech/gpt-4o-mini-tts, metric tts_characters', () => {
    expect(executableSql).toMatch(/INSERT INTO public\.provider_pricing/);
    expect(executableSql).toMatch(/'openai', 'audio\.speech', 'gpt-4o-mini-tts'/);
    expect(executableSql).toMatch(/'tts_characters'/);
  });

  it('is idempotent (WHERE NOT EXISTS on the active row)', () => {
    expect(executableSql).toMatch(/WHERE NOT EXISTS \(\s*SELECT 1 FROM public\.provider_pricing/);
    expect(executableSql).toMatch(/model = 'gpt-4o-mini-tts'[\s\S]*valid_until IS NULL/);
  });

  it('only INSERTs — never updates or deletes existing prices', () => {
    expect(executableSql).not.toMatch(/\bUPDATE\b/i);
    expect(executableSql).not.toMatch(/\bDELETE\b/i);
    expect(executableSql).not.toMatch(/\bDROP\b/i);
    expect(executableSql).not.toMatch(/\bTRUNCATE\b/i);
  });

  it('never references the old app name', () => {
    expect(sql).not.toMatch(/Lemon/);
  });
});
