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

  it('fails open (enabled + unlimited) for every feature when nothing is configured for the resolved plan version', async () => {
    const supabase = makeMockSupabase({
      planRow: RESOLVED_PLAN,
      tableResults: {
        // Matches the real remote state today: only the conversation monthly
        // seconds capability has ever been configured for the free plan.
        plan_capability_values: { data: [{ capability_key: 'conversation.realtime.seconds.monthly', value: 600 }], error: null },
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
    expect(snapshot.conversation.monthlyTime.state).toBe('available');
    expect(snapshot.conversation.monthlyTime.limit).toBe(600);
    expect(snapshot.conversation.monthlyTime.remaining).toBe(600);
  });

  it('reflects real consumption counts pulled from the domain tables', async () => {
    const supabase = makeMockSupabase({
      planRow: RESOLVED_PLAN,
      tableResults: {
        plan_capability_values: {
          data: [
            { capability_key: 'writing.theme_generations_per_day', value: 2 },
            { capability_key: 'writing.theme_generations_per_day.unlimited', value: false },
          ],
          error: null,
        },
        generated_themes: { data: null, error: null, count: 2 },
        english_reviews: { data: null, error: null, count: 0 },
        pronunciation_assessments: { data: null, error: null, count: 0 },
        conversation_sessions: { data: [{ duration_sec: 300 }, { duration_sec: 120 }], error: null },
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
        plan_capability_values: { data: [{ capability_key: 'conversation.realtime.seconds.monthly', value: 600 }], error: null },
        conversation_sessions: { data: [{ duration_sec: 600 }], error: null },
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
        plan_capability_values: { data: [{ capability_key: 'conversation.realtime.seconds.monthly', value: 600 }], error: null },
        conversation_sessions: { data: [{ duration_sec: 600 }], error: null },
      },
    });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-18T12:00:00Z') });

    expect(snapshot.conversation.monthlyTime.state).toBe('monthly_limit_reached');
    expect(snapshot.conversation.monthlyTime.canStart).toBe(false);
  });

  it('respects an explicit writing.enabled=false plan value (disabled_by_plan, not unlimited)', async () => {
    const supabase = makeMockSupabase({
      planRow: RESOLVED_PLAN,
      tableResults: {
        plan_capability_values: { data: [{ capability_key: 'writing.enabled', value: false }], error: null },
      },
    });
    const snapshot = await getCurrentUserPlanEntitlements('u1', { supabase, now: new Date('2026-07-18T12:00:00Z') });

    expect(snapshot.writing.enabled).toBe(false);
    expect(snapshot.writing.themeGenerations.state).toBe('disabled_by_plan');
    expect(snapshot.writing.themeGenerations.canStart).toBe(false);
  });

  it('never trusts a client-supplied plan id — always resolves via the authenticated userId only', async () => {
    const supabase = makeMockSupabase({ planRow: RESOLVED_PLAN });
    await getCurrentUserPlanEntitlements('the-real-user-id', { supabase, now: new Date('2026-07-18T12:00:00Z') });

    expect(supabase.rpc).toHaveBeenCalledWith('admin_resolve_effective_plan_v1', expect.objectContaining({ p_user_id: 'the-real-user-id' }));
  });
});
