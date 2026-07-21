import { describe, it, expect, vi } from 'vitest';
import { getCurrentUserPlanEntitlements } from '../_entitlements/plan-entitlements-service';

function makeChain(result: { data: unknown; error?: unknown; count?: number }) {
  const resolved = Promise.resolve(result);
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    gte: () => chain,
    lt: () => chain,
    in: () => chain,
    not: () => chain,
    or: () => chain,
    order: () => chain,
    gt: () => chain,
    lte: () => chain,
    maybeSingle: () => resolved,
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => resolved.then(resolve, reject),
  };
  return chain;
}

interface MockOptions {
  planRow: Record<string, unknown> | null;
  tableResults?: Record<string, { data: unknown; error?: unknown; count?: number }>;
}

function makeMockSupabase({ planRow, tableResults = {} }: MockOptions) {
  return {
    rpc: vi.fn().mockResolvedValue({ data: planRow ? [planRow] : [], error: null }),
    from: vi.fn((table: string) => makeChain(tableResults[table] ?? { data: [], error: null, count: 0 })),
  } as any;
}

const RESOLVED_PLAN = {
  user_id: 'u1',
  access_allowed: true,
  plan_id: 'plan-1',
  plan_code: 'free',
  plan_name: 'Gratuito',
  plan_version_id: 'version-1',
  version_number: 1,
  is_suspended: false,
};

describe('getCurrentUserPlanEntitlements', () => {
  it('returns a fully locked snapshot when the user is suspended', async () => {
    const supabase = makeMockSupabase({ planRow: { ...RESOLVED_PLAN, access_allowed: false, is_suspended: true } });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-18T12:00:00Z') });

    expect(snapshot.suspended).toBe(true);
    expect(snapshot.writing.enabled).toBe(false);
    expect(snapshot.listening.enabled).toBe(false);
    expect(snapshot.pronunciation.enabled).toBe(false);
    expect(snapshot.conversation.enabled).toBe(false);
  });

  it('scenario 9: fails open (enabled + unlimited) for every feature when the plan version has NO entitlements configured at all', async () => {
    const supabase = makeMockSupabase({
      planRow: RESOLVED_PLAN,
      tableResults: {
        plan_capability_values: { data: [], error: null },
      },
    });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-18T12:00:00Z') });

    expect(snapshot.writing.enabled).toBe(true);
    expect(snapshot.writing.themeGenerations.state).toBe('unlimited');
    expect(snapshot.writing.reviews.state).toBe('unlimited');
    expect(snapshot.writing.maxCharactersUnlimited).toBe(true);

    expect(snapshot.listening.enabled).toBe(true);
    expect(snapshot.listening.stories.state).toBe('unlimited');

    expect(snapshot.pronunciation.enabled).toBe(true);
    expect(snapshot.pronunciation.evaluations.state).toBe('unlimited');

    expect(snapshot.conversation.enabled).toBe(true);
    expect(snapshot.conversation.monthlyTime.state).toBe('unlimited');
  });

  it('scenario 10: a structured legacy_fallback event is logged for each capability that fails open', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const supabase = makeMockSupabase({ planRow: RESOLVED_PLAN, tableResults: { plan_capability_values: { data: [], error: null } } });
      await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-18T12:00:00Z') });

      expect(warnSpy).toHaveBeenCalled();
      const firstLog = JSON.parse(warnSpy.mock.calls[0][0] as string);
      expect(firstLog.event).toBe('entitlements.legacy_fallback');
      expect(firstLog.plan_id).toBe('plan-1');
      expect(firstLog.plan_version_id).toBe('version-1');
      expect(typeof firstLog.capability_key).toBe('string');
      // Never leak anything beyond identifiers.
      expect(Object.keys(firstLog).sort()).toEqual(['capability_key', 'event', 'plan_id', 'plan_version_id']);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('scenario 11/15: a plan version with SOME configuration but missing a required key becomes config_error, never unlimited, and blocks that feature', async () => {
    const supabase = makeMockSupabase({
      planRow: RESOLVED_PLAN,
      tableResults: {
        // Only conversation's monthly seconds is configured — every other
        // capability (including conversation.enabled itself) is missing on
        // an otherwise-configured plan version.
        plan_capability_values: { data: [{ capability_key: 'conversation.realtime.seconds.monthly', value: 600 }], error: null },
      },
    });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-18T12:00:00Z') });

    expect(snapshot.writing.enabled).toBe(false);
    expect(snapshot.writing.themeGenerations.state).toBe('config_error');
    expect(snapshot.writing.themeGenerations.unlimited).toBe(false);
    expect(snapshot.writing.reviews.state).toBe('config_error');

    expect(snapshot.listening.enabled).toBe(false);
    expect(snapshot.listening.stories.state).toBe('config_error');

    expect(snapshot.pronunciation.enabled).toBe(false);
    expect(snapshot.pronunciation.evaluations.state).toBe('config_error');

    // conversation.enabled itself is missing even though the monthly seconds
    // pair is configured — the whole feature is unresolvable, not just the
    // sub-limit that happens to be missing.
    expect(snapshot.conversation.enabled).toBe(false);
    expect(snapshot.conversation.monthlyTime.state).toBe('config_error');
  });

  it('scenario 16: config_error is logged as a technical alert distinct from legacy_fallback', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const supabase = makeMockSupabase({
        planRow: RESOLVED_PLAN,
        tableResults: { plan_capability_values: { data: [{ capability_key: 'conversation.realtime.seconds.monthly', value: 600 }], error: null } },
      });
      await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-18T12:00:00Z') });

      expect(errorSpy).toHaveBeenCalled();
      const firstLog = JSON.parse(errorSpy.mock.calls[0][0] as string);
      expect(firstLog.event).toBe('entitlements.config_error');
      expect(firstLog.plan_id).toBe('plan-1');
      expect(firstLog.plan_version_id).toBe('version-1');
      expect(typeof firstLog.capability_key).toBe('string');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('reflects real consumption counts pulled from the domain tables', async () => {
    const supabase = makeMockSupabase({
      planRow: RESOLVED_PLAN,
      tableResults: {
        plan_capability_values: {
          data: [
            { capability_key: 'writing.enabled', value: true },
            { capability_key: 'writing.theme_generations_per_day', value: 2 },
            { capability_key: 'writing.theme_generations_per_day.unlimited', value: false },
            { capability_key: 'writing.reviews_per_day.unlimited', value: true },
            { capability_key: 'writing.max_characters_per_text.unlimited', value: true },
          ],
          error: null,
        },
        generated_themes: { data: null, error: null, count: 2 },
        english_reviews: { data: null, error: null, count: 0 },
        pronunciation_assessments: { data: null, error: null, count: 0 },
        conversation_session_authorizations: {
          data: [
            { status: 'completed', authorized_at: '2026-07-18T10:00:00Z', authorized_max_seconds: 1800, duration_seconds: 300 },
            { status: 'completed', authorized_at: '2026-07-18T10:00:00Z', authorized_max_seconds: 1800, duration_seconds: 120 },
          ],
          error: null,
        },
      },
    });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-18T12:00:00Z') });

    expect(snapshot.writing.themeGenerations.consumed).toBe(2);
    expect(snapshot.writing.themeGenerations.limit).toBe(2);
    expect(snapshot.writing.themeGenerations.state).toBe('daily_limit_reached');
    expect(snapshot.writing.themeGenerations.canStart).toBe(false);
  });

  it('unlocks available_with_extra_credits once the monthly conversation limit is exhausted but credits remain', async () => {
    const supabase = makeMockSupabase({
      planRow: RESOLVED_PLAN,
      tableResults: {
        plan_capability_values: {
          data: [
            { capability_key: 'conversation.enabled', value: true },
            { capability_key: 'conversation.realtime.seconds.monthly', value: 600 },
            { capability_key: 'conversation.max_recording_seconds.unlimited', value: true },
            { capability_key: 'conversation.extra_purchase_enabled', value: true },
          ],
          error: null,
        },
        conversation_session_authorizations: {
          data: [{ status: 'completed', authorized_at: '2026-07-18T10:00:00Z', authorized_max_seconds: 1800, duration_seconds: 600 }],
          error: null,
        },
        user_conversation_credits: { data: [{ remaining_seconds: 200 }], error: null },
      },
    });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-18T12:00:00Z') });

    expect(snapshot.conversation.monthlyTime.state).toBe('available_with_extra_credits');
    expect(snapshot.conversation.monthlyTime.remaining).toBe(200);
    expect(snapshot.conversation.extraSecondsAvailable).toBe(200);
  });

  it('reports monthly_limit_reached (not daily) when conversation minutes are exhausted with no extra credits', async () => {
    const supabase = makeMockSupabase({
      planRow: RESOLVED_PLAN,
      tableResults: {
        plan_capability_values: {
          data: [
            { capability_key: 'conversation.enabled', value: true },
            { capability_key: 'conversation.realtime.seconds.monthly', value: 600 },
            { capability_key: 'conversation.max_recording_seconds.unlimited', value: true },
            { capability_key: 'conversation.extra_purchase_enabled', value: true },
          ],
          error: null,
        },
        conversation_session_authorizations: {
          data: [{ status: 'completed', authorized_at: '2026-07-18T10:00:00Z', authorized_max_seconds: 1800, duration_seconds: 600 }],
          error: null,
        },
      },
    });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-18T12:00:00Z') });

    expect(snapshot.conversation.monthlyTime.state).toBe('monthly_limit_reached');
    expect(snapshot.conversation.monthlyTime.canStart).toBe(false);
  });

  it('audit fix: counts a still-open (never session-completed) authorization as consuming its elapsed time, not zero', async () => {
    // Regression test for the quota-bypass this migration closed: a session
    // that was authorized but whose /session-complete call never landed
    // (abandoned tab, client skipped the request, etc.) must still count
    // toward monthlyTime — otherwise never completing it is a free way to
    // dodge the monthly cap forever.
    const supabase = makeMockSupabase({
      planRow: RESOLVED_PLAN,
      tableResults: {
        plan_capability_values: {
          data: [
            { capability_key: 'conversation.enabled', value: true },
            { capability_key: 'conversation.realtime.seconds.monthly', value: 600 },
            { capability_key: 'conversation.max_recording_seconds.unlimited', value: true },
            { capability_key: 'conversation.extra_purchase_enabled', value: true },
          ],
          error: null,
        },
        conversation_session_authorizations: {
          // Authorized 20 minutes before "now" with a 30-minute ceiling —
          // still "in progress" from the server's point of view, so it
          // counts its elapsed 1200s, not the 0s a client-controlled
          // duration_sec could have claimed.
          data: [{ status: 'authorized', authorized_at: '2026-07-18T11:40:00Z', authorized_max_seconds: 1800, duration_seconds: null }],
          error: null,
        },
      },
    });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-18T12:00:00Z') });

    expect(snapshot.conversation.monthlyTime.consumed).toBe(1200);
    expect(snapshot.conversation.monthlyTime.remaining).toBe(0);
  });

  it('audit fix: caps an abandoned authorization at authorized_max_seconds, never lets it grow unbounded', async () => {
    const supabase = makeMockSupabase({
      planRow: RESOLVED_PLAN,
      tableResults: {
        plan_capability_values: {
          data: [
            { capability_key: 'conversation.enabled', value: true },
            { capability_key: 'conversation.realtime.seconds.monthly', value: 600 },
            { capability_key: 'conversation.max_recording_seconds.unlimited', value: true },
            { capability_key: 'conversation.extra_purchase_enabled', value: true },
          ],
          error: null,
        },
        conversation_session_authorizations: {
          // Authorized 10 days ago, 30-minute ceiling, never completed —
          // must be capped at 1800s, not (now - authorized_at) which would
          // be ~10 days.
          data: [{ status: 'authorized', authorized_at: '2026-07-08T12:00:00Z', authorized_max_seconds: 1800, duration_seconds: null }],
          error: null,
        },
      },
    });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-18T12:00:00Z') });

    expect(snapshot.conversation.monthlyTime.consumed).toBe(1800);
  });

  it('respects an explicit writing.enabled=false plan value (disabled_by_plan, not unlimited)', async () => {
    const supabase = makeMockSupabase({
      planRow: RESOLVED_PLAN,
      tableResults: {
        plan_capability_values: {
          data: [
            { capability_key: 'writing.enabled', value: false },
            { capability_key: 'writing.theme_generations_per_day.unlimited', value: true },
            { capability_key: 'writing.reviews_per_day.unlimited', value: true },
            { capability_key: 'writing.max_characters_per_text.unlimited', value: true },
          ],
          error: null,
        },
      },
    });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-18T12:00:00Z') });

    expect(snapshot.writing.enabled).toBe(false);
    expect(snapshot.writing.themeGenerations.state).toBe('disabled_by_plan');
    expect(snapshot.writing.themeGenerations.canStart).toBe(false);
  });

  it('counts distinct episode-based stories started today, not just whether any assignment exists', async () => {
    const supabase = makeMockSupabase({
      planRow: RESOLVED_PLAN,
      tableResults: {
        plan_capability_values: {
          data: [
            { capability_key: 'listening.enabled', value: true },
            { capability_key: 'listening.stories_per_day', value: 3 },
            { capability_key: 'listening.stories_per_day.unlimited', value: false },
          ],
          error: null,
        },
        // 2 distinct episodes already assigned today (multi-story day).
        user_listening_assignments: { data: null, error: null, count: 2 },
      },
    });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-18T12:00:00Z') });

    expect(snapshot.listening.stories.consumed).toBe(2);
    expect(snapshot.listening.stories.limit).toBe(3);
    expect(snapshot.listening.stories.remaining).toBe(1);
    expect(snapshot.listening.stories.canStart).toBe(true);
  });

  it('blocks a 4th story once the configured daily limit of distinct stories is reached', async () => {
    const supabase = makeMockSupabase({
      planRow: RESOLVED_PLAN,
      tableResults: {
        plan_capability_values: {
          data: [
            { capability_key: 'listening.enabled', value: true },
            { capability_key: 'listening.stories_per_day', value: 3 },
            { capability_key: 'listening.stories_per_day.unlimited', value: false },
          ],
          error: null,
        },
        user_listening_assignments: { data: null, error: null, count: 3 },
      },
    });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-18T12:00:00Z') });

    expect(snapshot.listening.stories.consumed).toBe(3);
    expect(snapshot.listening.stories.state).toBe('daily_limit_reached');
    expect(snapshot.listening.stories.canStart).toBe(false);
  });

  it('never trusts a client-supplied plan id — always resolves via the authenticated userId only', async () => {
    const supabase = makeMockSupabase({ planRow: RESOLVED_PLAN });
    await getCurrentUserPlanEntitlements('the-real-user-id', { supabase, now: new Date('2026-07-18T12:00:00Z') });

    expect(supabase.rpc).toHaveBeenCalledWith('admin_resolve_effective_plan_v1', expect.objectContaining({ p_user_id: 'the-real-user-id' }));
  });
});
