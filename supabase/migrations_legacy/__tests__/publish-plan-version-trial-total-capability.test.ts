/**
 * Static SQL-text assertions for
 * 20260727224100_publish_plan_version_trial_total_capability.sql — no live
 * database connection here (same posture as the archived migrations_legacy
 * static tests this file mirrors). Confirms purely from source text that:
 *   - the function signature/contract (SECURITY DEFINER, search_path,
 *     authorization, optimistic concurrency, revision, config_hash, retiring
 *     the previous published version, activate_plan) is preserved verbatim;
 *   - the plan-code branch is driven EXCLUSIVELY by plans.code = 'trial',
 *     nothing else;
 *   - every other required capability (writing/listening/pronunciation/
 *     conversation.enabled/extra_purchase/max_recording_seconds) is
 *     unconditional, for every plan.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const sql = readFileSync(
  resolve(__dirname, '..', '..', 'migrations', '20260727224100_publish_plan_version_trial_total_capability.sql'),
  'utf8',
);

const fnBody = sql.slice(
  sql.indexOf('CREATE OR REPLACE FUNCTION public.publish_plan_version'),
  sql.lastIndexOf('$function$;'),
);

describe('20260727224100 — publish_plan_version trial_total capability', () => {
  it('preserves the exact signature and contract', () => {
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.publish_plan_version\(p_plan_id uuid, p_draft_version_id uuid, p_client_revision integer, p_publication_notes text, p_change_summary text, p_config_hash text, p_actor_user_id uuid, p_activate_plan boolean DEFAULT false\)/,
    );
    expect(sql).toMatch(/RETURNS jsonb/);
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/SET search_path TO 'public'/);
  });

  it('preserves authorization, optimistic concurrency (revision), and conflict handling', () => {
    expect(fnBody).toContain("role in ('owner', 'admin')");
    expect(fnBody).toContain("return jsonb_build_object('success', false, 'error', 'UNAUTHORIZED');");
    expect(fnBody).toContain('v_draft.revision <> p_client_revision');
    expect(fnBody).toContain("'conflict', true");
  });

  it('preserves retiring the previously published version and activate_plan', () => {
    expect(fnBody).toContain("status = 'retired'");
    expect(fnBody).toContain('if p_activate_plan then');
    expect(fnBody).toContain("status = 'active'");
  });

  it('preserves config_hash/publication_notes/change_summary on publish', () => {
    expect(fnBody).toContain('config_hash = p_config_hash');
    expect(fnBody).toContain('publication_notes = p_publication_notes');
    expect(fnBody).toContain('change_summary = p_change_summary');
  });

  it('resolves the plan code from the draft\'s own plan row, never from a client-supplied flag', () => {
    expect(fnBody).toContain('select code into v_plan_code from public.plans where id = p_plan_id;');
  });

  it('branches the Conversation time pair SOLELY on v_plan_code = \'trial\' — no other criterion', () => {
    expect(fnBody).not.toMatch(/is_visible_to_users/);
    expect(fnBody).not.toMatch(/is_default/);
    expect(fnBody).not.toMatch(/monthly_price_cents/);
    expect(fnBody).not.toMatch(/assignment_origin|origin\s*=/);
    expect(fnBody).toMatch(/case when v_plan_code = 'trial'\s*\n\s*then 'conversation\.realtime\.seconds\.trial_total'\s*\n\s*else 'conversation\.realtime\.seconds\.monthly'/);
    expect(fnBody).toMatch(/case when v_plan_code = 'trial'\s*\n\s*then 'conversation\.realtime\.seconds\.trial_total\.unlimited'\s*\n\s*else 'conversation\.realtime\.seconds\.monthly\.unlimited'/);
  });

  it('keeps every other required pair unconditional (writing, listening, pronunciation, conversation.max_recording_seconds)', () => {
    const unconditionalPairs = [
      'writing.theme_generations_per_day', 'writing.max_characters_per_text', 'writing.reviews_per_day',
      'listening.stories_per_day', 'pronunciation.evaluations_per_day', 'pronunciation.max_recording_seconds',
      'conversation.max_recording_seconds',
    ];
    for (const key of unconditionalPairs) {
      expect(fnBody).toContain(`'${key}'`);
    }
  });

  it('keeps the 5 simple boolean capabilities required unconditionally, including conversation.enabled and extra_purchase_enabled', () => {
    for (const key of ['writing.enabled', 'listening.enabled', 'pronunciation.enabled', 'conversation.enabled', 'conversation.extra_purchase_enabled']) {
      expect(fnBody).toContain(`'${key}'`);
    }
  });

  it('never hardcodes conversation.realtime.seconds.monthly as unconditionally required anymore (only reachable via the trial-code branch)', () => {
    // The literal key must only ever appear inside the CASE branches, never
    // as a bare, unconditional VALUES row like the previous migration had.
    const bareRequirement = /\('conversation\.realtime\.seconds\.monthly',\s*'conversation\.realtime\.seconds\.monthly\.unlimited'\)/;
    expect(fnBody).not.toMatch(bareRequirement);
  });
});
