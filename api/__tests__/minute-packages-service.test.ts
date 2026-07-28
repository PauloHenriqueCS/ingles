/**
 * Unit tests for api/_entitlements/minute-packages-service.ts — the central
 * read of the conversation_minute_packages catalog. Verifies the two
 * independent gates (active, status='published') and per-package plan
 * compatibility are all enforced server-side, never trusting a caller-
 * supplied filter.
 */
import { describe, it, expect } from 'vitest';
import { listPublishedMinutePackages } from '../_entitlements/minute-packages-service';

interface FixtureRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  minutes: number;
  price_cents: number;
  currency: string;
  compatible_plan_codes: string[] | null;
  display_order: number;
  active: boolean;
  status: string;
}

function row(overrides: Partial<FixtureRow> & { id: string; code: string }): FixtureRow {
  return {
    name: `Pacote ${overrides.code}`,
    description: null,
    minutes: 60,
    price_cents: 1990,
    currency: 'BRL',
    compatible_plan_codes: null,
    display_order: 0,
    active: true,
    status: 'published',
    ...overrides,
  };
}

/** Mimics real Postgres/PostgREST filtering for .eq()/.order(), unlike a
 *  passthrough stub — required so tests genuinely exercise the WHERE clause
 *  the service issues, not just whatever fixture data was handed to it. */
function makeTableClient(rows: FixtureRow[], opts?: { error?: { message: string } }) {
  return {
    from: (table: string) => {
      expect(table).toBe('conversation_minute_packages');
      let filtered = [...rows];
      const builder: any = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          filtered = filtered.filter((r) => (r as any)[col] === val);
          return builder;
        },
        order: (col: string, options?: { ascending?: boolean }) => {
          if (opts?.error) return Promise.resolve({ data: null, error: opts.error });
          const dir = options?.ascending === false ? -1 : 1;
          filtered = [...filtered].sort((a, b) => {
            const av = (a as any)[col];
            const bv = (b as any)[col];
            return av > bv ? dir : av < bv ? -dir : 0;
          });
          return Promise.resolve({ data: filtered, error: null });
        },
      };
      return builder;
    },
  };
}

describe('listPublishedMinutePackages', () => {
  it('excludes an inactive package (active=false)', async () => {
    const client = makeTableClient([
      row({ id: '1', code: 'active-published', active: true, status: 'published' }),
      row({ id: '2', code: 'inactive', active: false, status: 'published' }),
    ]);
    const result = await listPublishedMinutePackages(client as any, 'essential');
    expect(result.map((p) => p.code)).toEqual(['active-published']);
  });

  it('excludes a package that is not published (status=draft)', async () => {
    const client = makeTableClient([
      row({ id: '1', code: 'active-published', active: true, status: 'published' }),
      row({ id: '2', code: 'draft-package', active: true, status: 'draft' }),
      row({ id: '3', code: 'archived-package', active: true, status: 'archived' }),
    ]);
    const result = await listPublishedMinutePackages(client as any, 'essential');
    expect(result.map((p) => p.code)).toEqual(['active-published']);
  });

  it('includes a package with no compatible_plan_codes restriction for any plan', async () => {
    const client = makeTableClient([row({ id: '1', code: 'any-plan', compatible_plan_codes: null })]);
    const result = await listPublishedMinutePackages(client as any, 'plus');
    expect(result.map((p) => p.code)).toEqual(['any-plan']);
  });

  it('includes a package with an empty compatible_plan_codes array for any plan', async () => {
    const client = makeTableClient([row({ id: '1', code: 'empty-list', compatible_plan_codes: [] })]);
    const result = await listPublishedMinutePackages(client as any, 'plus');
    expect(result.map((p) => p.code)).toEqual(['empty-list']);
  });

  it('excludes a package restricted to other plan codes', async () => {
    const client = makeTableClient([row({ id: '1', code: 'essential-only', compatible_plan_codes: ['essential'] })]);
    const result = await listPublishedMinutePackages(client as any, 'plus');
    expect(result).toEqual([]);
  });

  it('includes a package restricted to a list that contains the current plan', async () => {
    const client = makeTableClient([row({ id: '1', code: 'essential-only', compatible_plan_codes: ['essential', 'plus'] })]);
    const result = await listPublishedMinutePackages(client as any, 'essential');
    expect(result.map((p) => p.code)).toEqual(['essential-only']);
  });

  it('excludes every plan-restricted package when planCode is null', async () => {
    const client = makeTableClient([row({ id: '1', code: 'essential-only', compatible_plan_codes: ['essential'] })]);
    const result = await listPublishedMinutePackages(client as any, null);
    expect(result).toEqual([]);
  });

  it('orders results by display_order ascending', async () => {
    const client = makeTableClient([
      row({ id: '1', code: 'third', display_order: 30 }),
      row({ id: '2', code: 'first', display_order: 10 }),
      row({ id: '3', code: 'second', display_order: 20 }),
    ]);
    const result = await listPublishedMinutePackages(client as any, 'essential');
    expect(result.map((p) => p.code)).toEqual(['first', 'second', 'third']);
  });

  it('maps snake_case DB columns to the camelCase MinutePackage contract', async () => {
    const client = makeTableClient([
      row({ id: '1', code: 'mapped', name: 'Pacote 60 minutos', description: 'Minutos extras de conversação', minutes: 60, price_cents: 1990, currency: 'BRL' }),
    ]);
    const [pkg] = await listPublishedMinutePackages(client as any, 'essential');
    expect(pkg).toEqual({
      id: '1',
      code: 'mapped',
      name: 'Pacote 60 minutos',
      description: 'Minutos extras de conversação',
      minutes: 60,
      priceCents: 1990,
      currency: 'BRL',
    });
  });

  it('throws when the read fails', async () => {
    const client = makeTableClient([], { error: { message: 'connection lost' } });
    await expect(listPublishedMinutePackages(client as any, 'essential')).rejects.toThrow('conversation_minute_packages read failed: connection lost');
  });

  it('returns an empty list when the catalog has no rows', async () => {
    const client = makeTableClient([]);
    const result = await listPublishedMinutePackages(client as any, 'essential');
    expect(result).toEqual([]);
  });
});
