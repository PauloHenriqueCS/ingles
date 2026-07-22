import { describe, it, expect, vi } from 'vitest';
import { determineNextListeningGroupTargetLevel } from './determine-next-listening-group-target-level';

function makeSupabase(lastJob: { target_level: string } | null, errorMsg?: string) {
  const from = vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        order: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue(
              errorMsg ? { data: null, error: { message: errorMsg } } : { data: lastJob, error: null },
            ),
          }),
        }),
      }),
    }),
  });
  return { from } as any;
}

describe('determineNextListeningGroupTargetLevel', () => {
  it('starts at the group first member when there is no prior job', async () => {
    expect(await determineNextListeningGroupTargetLevel(makeSupabase(null), 'A1_A2')).toBe('A1');
    expect(await determineNextListeningGroupTargetLevel(makeSupabase(null), 'B1_B2')).toBe('B1');
    expect(await determineNextListeningGroupTargetLevel(makeSupabase(null), 'C1_C2')).toBe('C1');
  });

  it.each([
    ['A1_A2', 'A1', 'A2'],
    ['A1_A2', 'A2', 'A1'],
    ['B1_B2', 'B1', 'B2'],
    ['B1_B2', 'B2', 'B1'],
    ['C1_C2', 'C1', 'C2'],
    ['C1_C2', 'C2', 'C1'],
  ] as const)('alternates: last=%s/%s -> next=%s', async (group, last, expected) => {
    const supabase = makeSupabase({ target_level: last });
    expect(await determineNextListeningGroupTargetLevel(supabase, group)).toBe(expected);
  });

  it('deterministic alternation cycle across repeated calls (A1, A2, A1, A2, ...)', async () => {
    let last: string | null = null;
    const sequence: string[] = [];
    for (let i = 0; i < 4; i++) {
      const supabase = makeSupabase(last ? { target_level: last } : null);
      const next = await determineNextListeningGroupTargetLevel(supabase, 'A1_A2');
      sequence.push(next);
      last = next;
    }
    expect(sequence).toEqual(['A1', 'A2', 'A1', 'A2']);
  });

  it('propagates a database error instead of silently defaulting', async () => {
    await expect(
      determineNextListeningGroupTargetLevel(makeSupabase(null, 'db down'), 'A1_A2'),
    ).rejects.toThrow('db down');
  });
});
