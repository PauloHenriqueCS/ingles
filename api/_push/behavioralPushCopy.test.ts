import { describe, it, expect } from 'vitest';
import {
  buildBehavioralPushCopy,
  resolvePushLanguage,
  selectDailyPushCopy,
  DAILY_PRACTICE_COPIES,
} from './behavioralPushCopy';

/** Add whole days to a YYYY-MM-DD date. */
function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

describe('selectDailyPushCopy — global daily rotation', () => {
  const N = DAILY_PRACTICE_COPIES.length;

  it('has the 15 approved copies, in the approved order and exact wording', () => {
    expect(N).toBe(15);
    expect(DAILY_PRACTICE_COPIES[0]).toEqual({
      title: 'Não me abandonaaa 😭',
      body: 'Você tem 3 min pra salvar seu inglês hoje.',
    });
    expect(DAILY_PRACTICE_COPIES[5]).toEqual({
      title: 'VOLTA AQUI.',
      body: 'Seu inglês não vai praticar sozinho.',
    });
    expect(DAILY_PRACTICE_COPIES[14]).toEqual({
      title: 'Hoje você não escapa.',
      body: 'Uma prática rápida e estamos quites.',
    });
  });

  it('F: the same local_date always yields the same copy (all users, one voice)', () => {
    const a = selectDailyPushCopy('2026-09-14');
    const b = selectDailyPushCopy('2026-09-14');
    expect(b).toEqual(a);
    // The variant carries title/body identity, so two users get identical rows.
    expect(a.variant).toBe(b.variant);
    expect(a.title).toBe(b.title);
    expect(a.body).toBe(b.body);
  });

  it('G: the next local_date advances to the next copy in the list', () => {
    const day0 = '2026-09-14';
    const c0 = selectDailyPushCopy(day0);
    const c1 = selectDailyPushCopy(addDays(day0, 1));
    const idx0 = DAILY_PRACTICE_COPIES.findIndex((c) => c.title === c0.title);
    const idx1 = DAILY_PRACTICE_COPIES.findIndex((c) => c.title === c1.title);
    expect(idx1).toBe((idx0 + 1) % N);
  });

  it('H: after the last copy it wraps back to the first (period = list length)', () => {
    const day0 = '2026-09-14';
    // N days later → same copy again.
    expect(selectDailyPushCopy(addDays(day0, N))).toEqual(selectDailyPushCopy(day0));
    // The single wrap point: some day maps to index 0 and the next-day-after the
    // last index rolls over. Sweeping N consecutive days must hit every copy once.
    const seen = new Set<string>();
    for (let i = 0; i < N; i++) seen.add(selectDailyPushCopy(addDays(day0, i)).variant);
    expect(seen.size).toBe(N);
  });

  it('variant is stable, 1-based and zero-padded (practice_reminder_behavioral.v1.NN)', () => {
    for (let i = 0; i < N; i++) {
      const v = selectDailyPushCopy(addDays('2026-09-14', i)).variant;
      expect(v).toMatch(/^practice_reminder_behavioral\.v1\.\d{2}$/);
    }
  });

  it('is deterministic across a far-apart pair exactly one period apart', () => {
    expect(selectDailyPushCopy('2026-01-01')).toEqual(selectDailyPushCopy(addDays('2026-01-01', N * 7)));
  });
});

// ── Legacy per-type copy — historical only, no longer produced by the sweep ──

describe('resolvePushLanguage (legacy, still used for the interface_language snapshot)', () => {
  it('maps pt / pt-BR to pt and everything else to en', () => {
    expect(resolvePushLanguage('pt-BR')).toBe('pt');
    expect(resolvePushLanguage('pt')).toBe('pt');
    expect(resolvePushLanguage('en-US')).toBe('en');
    expect(resolvePushLanguage(null)).toBe('en');
    expect(resolvePushLanguage(undefined)).toBe('en');
  });
});

describe('buildBehavioralPushCopy (legacy)', () => {
  it('streak_risk pt: plural days', () => {
    const c = buildBehavioralPushCopy({ pushType: 'streak_risk', language: 'pt', streak: 8 });
    expect(c.body).toContain('8 dias');
    expect(c.variant).toBe('streak_risk.pt.v1');
  });

  it('abandonment pt', () => {
    const c = buildBehavioralPushCopy({ pushType: 'abandonment', language: 'pt', streak: 0 });
    expect(c.title).toBe('Que tal retomar hoje?');
    expect(c.variant).toBe('abandonment.pt.v1');
  });
});
