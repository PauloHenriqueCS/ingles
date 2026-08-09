/**
 * Static SQL-text assertions for
 * 20260727224000_conversation_trial_total_capability_definitions.sql — no
 * live database connection here (same posture as the other migration static
 * tests in this directory).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const sql = readFileSync(
  resolve(__dirname, '..', '..', 'migrations', '20260727224000_conversation_trial_total_capability_definitions.sql'),
  'utf8',
);

describe('20260727224000 — conversation trial_total capability_definitions', () => {
  it('registers both new keys, insert-if-absent only', () => {
    for (const key of ['conversation.realtime.seconds.trial_total', 'conversation.realtime.seconds.trial_total.unlimited']) {
      expect(sql).toContain(`'${key}',`);
    }
    expect((sql.match(/ON CONFLICT \(key\) DO NOTHING;/g) ?? []).length).toBe(2);
  });

  it('never uses ON CONFLICT DO UPDATE — an existing row (e.g. already created by ingles-dashboad) is never overwritten', () => {
    expect(sql).not.toMatch(/DO UPDATE SET/);
    expect(sql).not.toContain('EXCLUDED.');
  });

  it('preserves any existing label/description/display_order by construction — the reconciliation never touches an existing row\'s columns at all', () => {
    // Non-destructiveness here isn't "preserve these 3 fields but update
    // others" — it's structural: DO NOTHING means literally zero UPDATE
    // touches any column of a pre-existing row, visual or technical.
    const insertBlocks = sql.split('INSERT INTO public.capability_definitions').slice(1);
    expect(insertBlocks.length).toBe(2);
    for (const block of insertBlocks) {
      expect(block).toMatch(/ON CONFLICT \(key\) DO NOTHING;\s*$/);
    }
  });

  it('never touches or renames a different capability_definitions row', () => {
    expect(sql).not.toMatch(/INSERT INTO public\.capability_definitions[\s\S]*?'conversation\.realtime\.seconds\.monthly'/);
  });

  it('the base quota key\'s insert-only-if-absent defaults mirror the values already reconciled in lemon-homolog by ingles-dashboad (lifetime period, integer/seconds)', () => {
    expect(sql).toMatch(/'conversation\.realtime\.seconds\.trial_total',\s*\n\s*'quota',\s*\n\s*'conversation',[\s\S]*?'integer',\s*\n\s*'seconds',\s*\n\s*'lifetime',\s*\n\s*'\["lifetime"\]',\s*\n\s*'0',\s*\n\s*'\{"min":0\}',/);
  });

  it('the unlimited flag\'s insert-only-if-absent defaults default to false (boolean/none)', () => {
    expect(sql).toMatch(/'conversation\.realtime\.seconds\.trial_total\.unlimited',[\s\S]*?'boolean',\s*\n\s*'enabled',\s*\n\s*'none',\s*\n\s*'\["none"\]',\s*\n\s*'false',/);
  });

  it('both rows are plan-configurable and active', () => {
    const trialTotalBlock = sql.slice(sql.indexOf("'conversation.realtime.seconds.trial_total',"), sql.indexOf("'conversation.realtime.seconds.trial_total.unlimited',"));
    const unlimitedBlock = sql.slice(sql.indexOf("'conversation.realtime.seconds.trial_total.unlimited',"));
    for (const block of [trialTotalBlock, unlimitedBlock]) {
      expect(block).toMatch(/TRUE,\s*\n\s*TRUE,\s*\n\s*NULL,/);
    }
  });
});
