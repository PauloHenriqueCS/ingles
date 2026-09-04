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
  // The five daily-usage counters are now resolved by a single RPC
  // (resolve_daily_activity_counts_v1), not five .from(...).select(count) calls.
  // Derive that RPC's row from the SAME tableResults counts every test already
  // sets, so existing cases keep asserting consumption exactly as before.
  const dailyCounts = {
    theme_count: tableResults['generated_themes']?.count ?? 0,
    review_count: tableResults['writing_review_reservations']?.count ?? 0,
    pronunciation_eval_count: tableResults['pronunciation_assessments']?.count ?? 0,
    listening_count: tableResults['user_listening_shared_progress']?.count ?? 0,
    pronunciation_training_count: tableResults['pronunciation_training_sessions']?.count ?? 0,
  };
  return {
    rpc: vi.fn((name: string) =>
      name === 'resolve_daily_activity_counts_v1'
        ? Promise.resolve({ data: [dailyCounts], error: null })
        : Promise.resolve({ data: planRow ? [planRow] : [], error: null }),
    ),
    from: vi.fn((table: string) => makeChain(tableResults[table] ?? { data: [], error: null, count: 0 })),
  } as any;
}

// A genuine (non-fallback) assignment — assignment_id/starts_at populated,
// exactly as admin_resolve_effective_plan_v1's IF FOUND branch always
// returns them. Every existing test below uses this fixture to mean "a
// legitimately entitled, resolved plan"; see the dedicated 'subscription
// access gate' describe block further down for the fallback (no genuine
// assignment) case itself.
const RESOLVED_PLAN = {
  user_id: 'u1',
  access_allowed: true,
  plan_id: 'plan-1',
  plan_code: 'free',
  plan_name: 'Gratuito',
  plan_version_id: 'version-1',
  version_number: 1,
  is_suspended: false,
  assignment_id: 'assignment-free-1',
  starts_at: '2026-01-01T00:00:00Z',
  ends_at: null,
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
        writing_review_reservations: { data: null, error: null, count: 0 },
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

  // "Revisão" (writing.reviews) consumption: counted from
  // writing_review_reservations (the atomic reserve/complete ledger
  // api/review-text.ts writes to), never from english_reviews.entry_date —
  // entry_date is which diary day a review is ABOUT, not when it was
  // consumed, and is written for history display only.
  // The other writing.* capabilities (theme generations, max characters) are
  // configured as unlimited so they never contribute a config_error that
  // would cascade onto writing.reviews via the shared writingConfigError
  // flag — these three tests are only about the reviews sub-feature.
  const OTHER_WRITING_CAPS_UNLIMITED = [
    { capability_key: 'writing.theme_generations_per_day.unlimited', value: true },
    { capability_key: 'writing.max_characters_per_text.unlimited', value: true },
  ];

  it("counts writing.reviews consumption from writing_review_reservations, not english_reviews", async () => {
    const supabase = makeMockSupabase({
      planRow: RESOLVED_PLAN,
      tableResults: {
        plan_capability_values: {
          data: [
            { capability_key: 'writing.enabled', value: true },
            { capability_key: 'writing.reviews_per_day', value: 3 },
            { capability_key: 'writing.reviews_per_day.unlimited', value: false },
            ...OTHER_WRITING_CAPS_UNLIMITED,
          ],
          error: null,
        },
        writing_review_reservations: { data: null, error: null, count: 2 },
      },
    });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-18T12:00:00Z') });

    expect(snapshot.writing.reviews.consumed).toBe(2);
    expect(snapshot.writing.reviews.limit).toBe(3);
    expect(snapshot.writing.reviews.remaining).toBe(1);
    expect(snapshot.writing.reviews.canStart).toBe(true);
  });

  it('blocks writing.reviews once consumed reaches the plan limit', async () => {
    const supabase = makeMockSupabase({
      planRow: RESOLVED_PLAN,
      tableResults: {
        plan_capability_values: {
          data: [
            { capability_key: 'writing.enabled', value: true },
            { capability_key: 'writing.reviews_per_day', value: 1 },
            { capability_key: 'writing.reviews_per_day.unlimited', value: false },
            ...OTHER_WRITING_CAPS_UNLIMITED,
          ],
          error: null,
        },
        writing_review_reservations: { data: null, error: null, count: 1 },
      },
    });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-18T12:00:00Z') });

    expect(snapshot.writing.reviews.state).toBe('daily_limit_reached');
    expect(snapshot.writing.reviews.canStart).toBe(false);
  });

  // A user with no active plan assignment: admin_resolve_effective_plan_v1
  // (SQL, verified separately) falls back to the default (Free) plan and
  // returns access_allowed=true with that plan's real id/version — from this
  // function's perspective that is byte-identical to any other resolved
  // plan row, so the Free plan's actual configured writing.reviews values
  // apply exactly as they would for an explicit Free assignment. No special
  // "no plan" code path exists or is needed here.
  it('a resolved default (Free) plan for a user with no explicit assignment gets the same writing.reviews rules as an explicit Free assignment', async () => {
    const supabase = makeMockSupabase({
      planRow: { ...RESOLVED_PLAN, plan_code: 'free', plan_name: 'Gratuito' },
      tableResults: {
        plan_capability_values: {
          data: [
            { capability_key: 'writing.enabled', value: true },
            { capability_key: 'writing.reviews_per_day', value: 1 },
            { capability_key: 'writing.reviews_per_day.unlimited', value: false },
            ...OTHER_WRITING_CAPS_UNLIMITED,
          ],
          error: null,
        },
        writing_review_reservations: { data: null, error: null, count: 0 },
      },
    });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-18T12:00:00Z') });

    expect(snapshot.planCode).toBe('free');
    expect(snapshot.writing.reviews.limit).toBe(1);
    expect(snapshot.writing.reviews.canStart).toBe(true);
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

  it('abandon hotfix: a STALE-heartbeat open authorization is clamped to the last heartbeat, not the live elapsed', async () => {
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
          // Present for ~102s (last heartbeat at 12:01:42), then the user left;
          // "now" is 20 minutes later. Consumption must STOP climbing at the last
          // heartbeat + the stale window (75s) = 177s — never the live 20 min.
          data: [{ status: 'authorized', authorized_at: '2026-07-18T12:00:00Z', authorized_max_seconds: 1800, duration_seconds: null, last_seen_at: '2026-07-18T12:01:42Z' }],
          error: null,
        },
      },
    });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-18T12:20:00Z') });
    expect(snapshot.conversation.monthlyTime.consumed).toBe(177); // 102s real + 75s stale window
  });

  it('abandon hotfix: an actively-heartbeating open authorization still counts full live elapsed (never under-counted)', async () => {
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
          // Heartbeat 10s ago (still well within the stale window) → the session
          // is genuinely live, so consumption is the full elapsed 1200s.
          data: [{ status: 'authorized', authorized_at: '2026-07-18T11:40:00Z', authorized_max_seconds: 1800, duration_seconds: null, last_seen_at: '2026-07-18T11:59:50Z' }],
          error: null,
        },
      },
    });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-18T12:00:00Z') });
    expect(snapshot.conversation.monthlyTime.consumed).toBe(1200);
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

  it('counts distinct shared stories the user opened today from user_listening_shared_progress (cache reuse counts, not AI generation)', async () => {
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
        // The user opened 2 distinct shared stories today — the per-user-open
        // ledger attachUserProgress writes on BOTH the cache-hit and the
        // just-generated branch. This is the user's quota usage, independent
        // of how many (if any) AI generations happened.
        user_listening_shared_progress: { data: null, error: null, count: 2 },
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
        user_listening_shared_progress: { data: null, error: null, count: 3 },
      },
    });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-18T12:00:00Z') });

    expect(snapshot.listening.stories.consumed).toBe(3);
    expect(snapshot.listening.stories.state).toBe('daily_limit_reached');
    expect(snapshot.listening.stories.canStart).toBe(false);
  });

  it('scopes História consumption to the user\'s São Paulo day, not the UTC day (regression for the 21:00–24:00 SP miscount)', async () => {
    // now = 02:00 UTC on 2026-07-18 → 23:00 on 2026-07-17 America/Sao_Paulo.
    // The listening count MUST be scoped by the SP date (2026-07-17), never the
    // UTC date (2026-07-18). That date is now passed to resolve_daily_activity_
    // counts_v1 as p_sp_date (the RPC does the practice_date join) — capture the
    // RPC args to prove the São Paulo day is what crosses the boundary.
    const rpcCalls: Array<[string, Record<string, unknown>]> = [];
    const supabase = {
      rpc: vi.fn((name: string, args: Record<string, unknown>) => {
        rpcCalls.push([name, args]);
        return name === 'resolve_daily_activity_counts_v1'
          ? Promise.resolve({ data: [{ listening_count: 1 }], error: null })
          : Promise.resolve({ data: [RESOLVED_PLAN], error: null });
      }),
      from: vi.fn((table: string) =>
        table === 'plan_capability_values'
          ? makeChain({
              data: [
                { capability_key: 'listening.enabled', value: true },
                { capability_key: 'listening.stories_per_day', value: 3 },
                { capability_key: 'listening.stories_per_day.unlimited', value: false },
              ],
              error: null,
            })
          : makeChain({ data: [], error: null, count: 0 }),
      ),
    } as any;

    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-18T02:00:00Z') });

    const countsCall = rpcCalls.find(([name]) => name === 'resolve_daily_activity_counts_v1');
    expect(countsCall).toBeDefined();
    expect(countsCall?.[1].p_sp_date).toBe('2026-07-17');
    // Never falls back to the old episode-assignment source.
    expect(supabase.from).not.toHaveBeenCalledWith('user_listening_assignments');
    expect(snapshot.listening.stories.consumed).toBe(1);
  });

  it('never trusts a client-supplied plan id — always resolves via the authenticated userId only', async () => {
    const supabase = makeMockSupabase({ planRow: RESOLVED_PLAN });
    await getCurrentUserPlanEntitlements('the-real-user-id', { supabase, now: new Date('2026-07-18T12:00:00Z') });

    expect(supabase.rpc).toHaveBeenCalledWith('admin_resolve_effective_plan_v1', expect.objectContaining({ p_user_id: 'the-real-user-id' }));
  });
});

// ── Subscription access gate — the four activities require a GENUINE
// user_plan_assignments row, not merely access_allowed=true ────────────────
//
// admin_resolve_effective_plan_v1's access_allowed only reflects admin
// suspension. Whenever there is no active assignment row covering `now` —
// trial expired, a canceled/billing_issue subscription past its paid
// ends_at, or the user never had an assignment — the RPC falls back to
// plans.is_default (a safety-net plan the audit found still had
// writing/listening/pronunciation.enabled=true, only conversation.enabled
// was false — see 20260727230500_grant_signup_trial.sql's own "nunca teve
// conversation.enabled" comment). Without this gate, an expired/canceled/
// billing_issue user would keep a small but real daily allowance for three
// of the four activities. The gate must win regardless of what the fallback
// plan's own capability_values say — 'canceled'/'billing_issue' access
// windows are enforced entirely by the RPC's own WHERE clause (ends_at >
// p_at); by the time this service sees a fallback row, the paid period is
// already over, so this file never needs to special-case those two states —
// "no genuine assignment" already covers all three failure states uniformly.
describe('getCurrentUserPlanEntitlements — subscription access gate (genuine assignment required)', () => {
  // Mirrors the real plano-teste-lojas fallback found in homologation:
  // access_allowed=true (not suspended), no assignment_id/starts_at, and a
  // configuration that — if trusted — would still grant partial access.
  const FALLBACK_PLAN_ROW = {
    user_id: 'u1',
    access_allowed: true,
    plan_id: 'plan-default',
    plan_code: 'plano-teste-lojas',
    plan_name: 'Plano de teste lojas',
    plan_version_id: 'version-default-1',
    version_number: 1,
    is_suspended: false,
    assignment_id: null,
    starts_at: null,
    ends_at: null,
  };

  const PARTIALLY_OPEN_FALLBACK_CAPS = [
    { capability_key: 'writing.enabled', value: true },
    { capability_key: 'writing.theme_generations_per_day', value: 1 },
    { capability_key: 'writing.theme_generations_per_day.unlimited', value: false },
    { capability_key: 'writing.reviews_per_day', value: 1 },
    { capability_key: 'writing.reviews_per_day.unlimited', value: false },
    { capability_key: 'listening.enabled', value: true },
    { capability_key: 'listening.stories_per_day', value: 1 },
    { capability_key: 'listening.stories_per_day.unlimited', value: false },
    { capability_key: 'pronunciation.enabled', value: true },
    { capability_key: 'pronunciation.evaluations_per_day', value: 1 },
    { capability_key: 'pronunciation.evaluations_per_day.unlimited', value: false },
    { capability_key: 'conversation.enabled', value: false },
  ];

  it('trial expired / subscription canceled or billing_issue past its period (resolved via the default-plan fallback): blocks all four activities even though the fallback plan itself would grant three of them', async () => {
    const supabase = makeMockSupabase({
      planRow: FALLBACK_PLAN_ROW,
      tableResults: { plan_capability_values: { data: PARTIALLY_OPEN_FALLBACK_CAPS, error: null } },
    });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-18T12:00:00Z') });

    expect(snapshot.writing.enabled).toBe(false);
    expect(snapshot.writing.themeGenerations.canStart).toBe(false);
    expect(snapshot.listening.enabled).toBe(false);
    expect(snapshot.listening.stories.canStart).toBe(false);
    expect(snapshot.pronunciation.enabled).toBe(false);
    expect(snapshot.pronunciation.evaluations.canStart).toBe(false);
    expect(snapshot.conversation.enabled).toBe(false);
    expect(snapshot.conversation.monthlyTime.canStart).toBe(false);
    expect(snapshot.suspended).toBe(false); // fails closed for a different reason, never mislabeled as suspension
  });

  it('no plan resolved at all (RPC returns nothing, no default plan configured either): blocks all four activities', async () => {
    const supabase = makeMockSupabase({ planRow: null });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-18T12:00:00Z') });

    expect(snapshot.writing.enabled).toBe(false);
    expect(snapshot.listening.enabled).toBe(false);
    expect(snapshot.pronunciation.enabled).toBe(false);
    expect(snapshot.conversation.enabled).toBe(false);
  });

  it('trialing (genuine trial assignment) still resolves normal entitlements — the gate never blocks a valid trial', async () => {
    // No plan_capability_values rows at all -> the existing legacy-fallback
    // path (scenario 9 above) resolves every activity as enabled+unlimited.
    // The point of this test is only that the NEW gate itself does not zero
    // these out for a genuine trial assignment — capability completeness is
    // already covered by the trial-specific describe block below.
    const supabase = makeMockSupabase({
      planRow: {
        user_id: 'u1', access_allowed: true, plan_id: 'plan-trial', plan_code: 'trial', plan_name: 'Trial',
        plan_version_id: 'version-trial-1', version_number: 1, is_suspended: false,
        assignment_id: 'assignment-1', starts_at: '2026-07-10T00:00:00Z', ends_at: '2026-07-17T00:00:00Z',
      },
      tableResults: { plan_capability_values: { data: [], error: null } },
    });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-12T12:00:00Z') });

    expect(snapshot.writing.enabled).toBe(true);
    expect(snapshot.listening.enabled).toBe(true);
    expect(snapshot.pronunciation.enabled).toBe(true);
    expect(snapshot.conversation.enabled).toBe(true);
  });

  it('active commercial plan (genuine assignment, e.g. Essencial/Plus once published) is never blocked by the gate', async () => {
    const supabase = makeMockSupabase({ planRow: RESOLVED_PLAN });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-18T12:00:00Z') });

    // RESOLVED_PLAN has no plan_capability_values configured in this mock,
    // so the legacy-fallback (permissive) path applies — the point here is
    // only that the gate itself does not zero these out.
    expect(snapshot.writing.enabled).toBe(true);
    expect(snapshot.listening.enabled).toBe(true);
    expect(snapshot.pronunciation.enabled).toBe(true);
    expect(snapshot.conversation.enabled).toBe(true);
  });

  it('a still-valid canceled or billing_issue subscription (genuine assignment, ends_at in the future) is resolved exactly like any other active assignment — the RPC itself (ends_at > p_at), not this service, is what stops returning the row once the period ends', async () => {
    const supabase = makeMockSupabase({
      planRow: { ...RESOLVED_PLAN, ends_at: '2026-08-01T00:00:00Z' },
    });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-18T12:00:00Z') });

    expect(snapshot.writing.enabled).toBe(true);
    expect(snapshot.conversation.enabled).toBe(true);
  });
});

// ── Etapa 2A — the internal 'trial' plan's lifetime Conversation total ──────
describe('getCurrentUserPlanEntitlements — trial plan (conversation.realtime.seconds.trial_total)', () => {
  const RESOLVED_TRIAL_PLAN = {
    user_id: 'u1',
    access_allowed: true,
    plan_id: 'plan-trial',
    plan_code: 'trial',
    plan_name: 'Trial',
    plan_version_id: 'version-trial-1',
    version_number: 1,
    is_suspended: false,
    assignment_id: 'assignment-1',
    starts_at: '2026-07-10T00:00:00Z',
    ends_at: '2026-07-17T00:00:00Z',
  };

  const TRIAL_CAPS = [
    { capability_key: 'conversation.enabled', value: true },
    { capability_key: 'conversation.realtime.seconds.trial_total', value: 900 },
    { capability_key: 'conversation.realtime.seconds.trial_total.unlimited', value: false },
    { capability_key: 'conversation.max_recording_seconds.unlimited', value: true },
    { capability_key: 'conversation.extra_purchase_enabled', value: false },
  ];

  it('resolves conversation from trial_total/trial_total.unlimited, with period lifetime, never monthly', async () => {
    const supabase = makeMockSupabase({
      planRow: RESOLVED_TRIAL_PLAN,
      tableResults: { plan_capability_values: { data: TRIAL_CAPS, error: null } },
    });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-12T12:00:00Z') });

    expect(snapshot.planCode).toBe('trial');
    expect(snapshot.conversation.monthlyTime.limit).toBe(900);
    expect(snapshot.conversation.monthlyTime.unlimited).toBe(false);
    expect(snapshot.conversation.monthlyTime.period).toBe('lifetime');
    expect(snapshot.conversation.monthlyTime.state).toBe('available');
    expect(snapshot.conversation.monthlyTime.remaining).toBe(900);
    expect(snapshot.monthlyRenewsAt).toBeNull();
  });

  it('exposes the active trial assignment window (id/startsAt/endsAt)', async () => {
    const supabase = makeMockSupabase({
      planRow: RESOLVED_TRIAL_PLAN,
      tableResults: { plan_capability_values: { data: TRIAL_CAPS, error: null } },
    });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-12T12:00:00Z') });

    expect(snapshot.trialAssignment).toEqual({
      id: 'assignment-1', startsAt: '2026-07-10T00:00:00Z', endsAt: '2026-07-17T00:00:00Z',
    });
  });

  it('900 available and 0 used -> 900 remaining', async () => {
    const supabase = makeMockSupabase({
      planRow: RESOLVED_TRIAL_PLAN,
      tableResults: {
        plan_capability_values: { data: TRIAL_CAPS, error: null },
        conversation_session_authorizations: { data: [], error: null },
      },
    });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-12T12:00:00Z') });
    expect(snapshot.conversation.monthlyTime.remaining).toBe(900);
  });

  it('900 available and 300 used -> 600 remaining', async () => {
    const supabase = makeMockSupabase({
      planRow: RESOLVED_TRIAL_PLAN,
      tableResults: {
        plan_capability_values: { data: TRIAL_CAPS, error: null },
        conversation_session_authorizations: {
          data: [{ status: 'completed', authorized_at: '2026-07-11T10:00:00Z', authorized_max_seconds: 900, duration_seconds: 300 }],
          error: null,
        },
      },
    });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-12T12:00:00Z') });
    expect(snapshot.conversation.monthlyTime.consumed).toBe(300);
    expect(snapshot.conversation.monthlyTime.remaining).toBe(600);
    expect(snapshot.conversation.monthlyTime.canStart).toBe(true);
  });

  it('900 available and 900 used -> 0 remaining, trial_balance_exhausted, canStart false', async () => {
    const supabase = makeMockSupabase({
      planRow: RESOLVED_TRIAL_PLAN,
      tableResults: {
        plan_capability_values: { data: TRIAL_CAPS, error: null },
        conversation_session_authorizations: {
          data: [{ status: 'completed', authorized_at: '2026-07-11T10:00:00Z', authorized_max_seconds: 900, duration_seconds: 900 }],
          error: null,
        },
      },
    });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-12T12:00:00Z') });
    expect(snapshot.conversation.monthlyTime.remaining).toBe(0);
    expect(snapshot.conversation.monthlyTime.state).toBe('trial_balance_exhausted');
    expect(snapshot.conversation.monthlyTime.canStart).toBe(false);
  });

  it('consumption never goes negative even if a stray row over-reports duration', async () => {
    const supabase = makeMockSupabase({
      planRow: RESOLVED_TRIAL_PLAN,
      tableResults: {
        plan_capability_values: { data: TRIAL_CAPS, error: null },
        conversation_session_authorizations: {
          data: [{ status: 'completed', authorized_at: '2026-07-11T10:00:00Z', authorized_max_seconds: 900, duration_seconds: 5000 }],
          error: null,
        },
      },
    });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-12T12:00:00Z') });
    expect(snapshot.conversation.monthlyTime.remaining).toBe(0);
  });

  it('a still-authorized (in-progress) row counts its live elapsed time, same rule as the monthly path', async () => {
    const supabase = makeMockSupabase({
      planRow: RESOLVED_TRIAL_PLAN,
      tableResults: {
        plan_capability_values: { data: TRIAL_CAPS, error: null },
        conversation_session_authorizations: {
          data: [{ status: 'authorized', authorized_at: '2026-07-12T11:45:00Z', authorized_max_seconds: 1800, duration_seconds: null }],
          error: null,
        },
      },
    });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-12T12:00:00Z') });
    expect(snapshot.conversation.monthlyTime.consumed).toBe(900); // 15 min elapsed
    expect(snapshot.conversation.monthlyTime.remaining).toBe(0);
  });

  it('a month boundary crossing does not reset the trial balance (same data, different calendar month, same result)', async () => {
    const rows = [{ status: 'completed', authorized_at: '2026-07-11T10:00:00Z', authorized_max_seconds: 900, duration_seconds: 300 }];
    const julySupabase = makeMockSupabase({
      planRow: RESOLVED_TRIAL_PLAN,
      tableResults: { plan_capability_values: { data: TRIAL_CAPS, error: null }, conversation_session_authorizations: { data: rows, error: null } },
    });
    const augustSupabase = makeMockSupabase({
      planRow: RESOLVED_TRIAL_PLAN,
      tableResults: { plan_capability_values: { data: TRIAL_CAPS, error: null }, conversation_session_authorizations: { data: rows, error: null } },
    });
    const julySnapshot = await getCurrentUserPlanEntitlements('u1', { supabase: julySupabase, now: new Date('2026-07-12T12:00:00Z') });
    const augustSnapshot = await getCurrentUserPlanEntitlements('u1', { supabase: augustSupabase, now: new Date('2026-08-05T12:00:00Z') });
    expect(julySnapshot.conversation.monthlyTime.remaining).toBe(600);
    expect(augustSnapshot.conversation.monthlyTime.remaining).toBe(600);
  });

  it('bounds the consumption query by the assignment window (authorized_at), never the calendar month', async () => {
    const gteCalls: unknown[] = [];
    const ltCalls: unknown[] = [];
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      gte: (...args: unknown[]) => { gteCalls.push(args); return chain; },
      lt: (...args: unknown[]) => { ltCalls.push(args); return chain; },
      in: () => chain,
      not: () => chain,
      or: () => chain,
      order: () => chain,
      gt: () => chain,
      lte: () => chain,
      maybeSingle: () => Promise.resolve({ data: null }),
      then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }),
    };
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: [RESOLVED_TRIAL_PLAN], error: null }),
      from: vi.fn((table: string) => {
        if (table === 'conversation_session_authorizations') return chain;
        return makeChain(table === 'plan_capability_values' ? { data: TRIAL_CAPS, error: null } : { data: [], error: null, count: 0 });
      }),
    } as any;

    await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-12T12:00:00Z') });

    expect(gteCalls).toContainEqual(['authorized_at', RESOLVED_TRIAL_PLAN.starts_at]);
    expect(ltCalls).toContainEqual(['authorized_at', RESOLVED_TRIAL_PLAN.ends_at]);
    // Never queried by the calendar-month session_date bounds.
    expect(gteCalls).not.toContainEqual(['session_date', expect.anything()]);
  });

  it('a commercial plan continues reading monthly and completely ignores a stray trial_total value', async () => {
    const supabase = makeMockSupabase({
      planRow: RESOLVED_PLAN, // plan_code: 'free'
      tableResults: {
        plan_capability_values: {
          data: [
            { capability_key: 'conversation.enabled', value: true },
            { capability_key: 'conversation.realtime.seconds.monthly', value: 600 },
            { capability_key: 'conversation.realtime.seconds.monthly.unlimited', value: false },
            { capability_key: 'conversation.realtime.seconds.trial_total', value: 900 },
            { capability_key: 'conversation.realtime.seconds.trial_total.unlimited', value: false },
            { capability_key: 'conversation.max_recording_seconds.unlimited', value: true },
            { capability_key: 'conversation.extra_purchase_enabled', value: false },
          ],
          error: null,
        },
      },
    });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-18T12:00:00Z') });

    expect(snapshot.conversation.monthlyTime.limit).toBe(600);
    expect(snapshot.conversation.monthlyTime.period).toBe('month');
  });

  it('a trial plan with only monthly configured (no trial_total) becomes config_error — never silently falls back to the monthly value', async () => {
    const supabase = makeMockSupabase({
      planRow: RESOLVED_TRIAL_PLAN,
      tableResults: {
        plan_capability_values: {
          data: [
            { capability_key: 'conversation.enabled', value: true },
            { capability_key: 'conversation.realtime.seconds.monthly', value: 600 },
            { capability_key: 'conversation.realtime.seconds.monthly.unlimited', value: false },
            { capability_key: 'conversation.max_recording_seconds.unlimited', value: true },
            { capability_key: 'conversation.extra_purchase_enabled', value: false },
          ],
          error: null,
        },
      },
    });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-12T12:00:00Z') });

    expect(snapshot.conversation.monthlyTime.state).toBe('config_error');
    expect(snapshot.conversation.enabled).toBe(false);
  });

  it('a trial-coded plan resolved WITHOUT a real assignment (no assignment_id/starts_at) is the subscription-access gate\'s fallback case — fully locked, never unlimited, never config_error alone', async () => {
    // The subscription-access gate (see the dedicated describe block below)
    // now catches this before any capability is even read: assignment_id/
    // starts_at both null means "no genuine assignment", exactly the shape
    // admin_resolve_effective_plan_v1's default-plan fallback returns. This
    // used to reach the trial-specific trialWindowMissing/config_error path
    // for conversation only — now every activity fails closed, which is the
    // strictly safer outcome and the actual point of the gate.
    const supabase = makeMockSupabase({
      planRow: { ...RESOLVED_TRIAL_PLAN, assignment_id: null, starts_at: null, ends_at: null },
      tableResults: { plan_capability_values: { data: TRIAL_CAPS, error: null } },
    });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-12T12:00:00Z') });

    expect(snapshot.conversation.enabled).toBe(false);
    expect(snapshot.conversation.monthlyTime.unlimited).toBe(false);
    expect(snapshot.conversation.monthlyTime.canStart).toBe(false);
    expect(snapshot.writing.enabled).toBe(false);
    expect(snapshot.listening.enabled).toBe(false);
    expect(snapshot.pronunciation.enabled).toBe(false);
    expect(snapshot.trialAssignment).toBeNull();
  });

  it('trial_total = 0 with unlimited=false means zero balance, not unlimited', async () => {
    const supabase = makeMockSupabase({
      planRow: RESOLVED_TRIAL_PLAN,
      tableResults: {
        plan_capability_values: {
          data: [
            { capability_key: 'conversation.enabled', value: true },
            { capability_key: 'conversation.realtime.seconds.trial_total', value: 0 },
            { capability_key: 'conversation.realtime.seconds.trial_total.unlimited', value: false },
            { capability_key: 'conversation.max_recording_seconds.unlimited', value: true },
            { capability_key: 'conversation.extra_purchase_enabled', value: false },
          ],
          error: null,
        },
      },
    });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-12T12:00:00Z') });

    expect(snapshot.conversation.monthlyTime.unlimited).toBe(false);
    expect(snapshot.conversation.monthlyTime.limit).toBe(0);
    expect(snapshot.conversation.monthlyTime.state).toBe('trial_balance_exhausted');
    expect(snapshot.conversation.monthlyTime.canStart).toBe(false);
  });
});
