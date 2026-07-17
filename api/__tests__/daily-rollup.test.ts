/**
 * Unit tests for the daily rollup orchestration layer
 * (rebuildDailyBucketForEvent, reconcileDailyBucketsForDate).
 *
 * Scope note: the actual aggregation (grain separation, status counting,
 * distinct correlation_id counting, cache hits, NUMERIC cost precision, UTC
 * day boundary, NULL-safe upsert, advisory-lock concurrency) lives in the
 * Postgres functions in migration 20260717110000_ai_gateway_daily_rollup.sql
 * and is NOT re-implemented or re-tested here — that SQL is validated
 * directly against Supabase per the project's deploy process (see the
 * delivery report's validation queries). This file only tests the
 * TypeScript orchestration around those RPCs: delegation, pagination
 * bounds, and independent failure handling.
 */

import { describe, it, expect, vi } from 'vitest';
import { rebuildDailyBucketForEvent, reconcileDailyBucketsForDate } from '../_ai-gateway/daily-rollup';
import type { DailyRollupRepositoryInterface, DailyBucketKey } from '../_ai-gateway/daily-rollup-repository';

function makeRepo(overrides: Partial<DailyRollupRepositoryInterface> = {}): DailyRollupRepositoryInterface {
  return {
    rebuildBucketForEvent: overrides.rebuildBucketForEvent ?? (async () => 'bucket-id'),
    rebuildBucket: overrides.rebuildBucket ?? (async () => 'bucket-id'),
    listBucketsForDate: overrides.listBucketsForDate ?? (async () => []),
  };
}

function bucket(key: string): DailyBucketKey {
  return {
    bucketKey: key,
    usageDate: '2026-07-17',
    userId: 'user-1',
    actorType: 'user',
    featureKey: 'writing.correct',
    provider: 'openai',
    model: 'gpt-4o-mini',
  };
}

// ── rebuildDailyBucketForEvent ─────────────────────────────────────────────────

describe('rebuildDailyBucketForEvent', () => {
  it('delegates to the repository with the given event id', async () => {
    const rebuildBucketForEvent = vi.fn().mockResolvedValue('daily-row-1');
    const repo = makeRepo({ rebuildBucketForEvent });

    const result = await rebuildDailyBucketForEvent('event-1', { dailyRollupRepository: repo, logger: vi.fn() });

    expect(rebuildBucketForEvent).toHaveBeenCalledWith('event-1');
    expect(result).toBe('daily-row-1');
  });

  it('returns null when the event does not exist, without throwing', async () => {
    const repo = makeRepo({ rebuildBucketForEvent: async () => null });
    const result = await rebuildDailyBucketForEvent('missing-event', { dailyRollupRepository: repo, logger: vi.fn() });
    expect(result).toBeNull();
  });
});

// ── reconcileDailyBucketsForDate — pagination ──────────────────────────────────

describe('reconcileDailyBucketsForDate — pagination', () => {
  it('processes a single page smaller than pageSize and stops', async () => {
    const listBucketsForDate = vi.fn().mockResolvedValue([bucket('a'), bucket('b')]);
    const rebuildBucket = vi.fn().mockResolvedValue('id');
    const repo = makeRepo({ listBucketsForDate, rebuildBucket });

    const outcome = await reconcileDailyBucketsForDate('2026-07-17', { dailyRollupRepository: repo, logger: vi.fn() }, 10);

    expect(listBucketsForDate).toHaveBeenCalledTimes(1);
    expect(rebuildBucket).toHaveBeenCalledTimes(2);
    expect(outcome.bucketsProcessed).toBe(2);
    expect(outcome.lastBucketKey).toBe('b');
  });

  it('pages through multiple full pages using the cursor from the previous page', async () => {
    const listBucketsForDate = vi.fn()
      .mockResolvedValueOnce([bucket('a'), bucket('b')])
      .mockResolvedValueOnce([bucket('c'), bucket('d')])
      .mockResolvedValueOnce([bucket('e')]); // smaller than pageSize -> stop
    const repo = makeRepo({ listBucketsForDate, rebuildBucket: vi.fn().mockResolvedValue('id') });

    const outcome = await reconcileDailyBucketsForDate('2026-07-17', { dailyRollupRepository: repo, logger: vi.fn() }, 2);

    expect(listBucketsForDate).toHaveBeenCalledTimes(3);
    expect(listBucketsForDate.mock.calls[0]).toEqual(['2026-07-17', 2, null]);
    expect(listBucketsForDate.mock.calls[1]).toEqual(['2026-07-17', 2, 'b']);
    expect(listBucketsForDate.mock.calls[2]).toEqual(['2026-07-17', 2, 'd']);
    expect(outcome.bucketsProcessed).toBe(5);
    expect(outcome.lastBucketKey).toBe('e');
  });

  it('never fetches raw events — only bucket keys and per-bucket rebuild calls', async () => {
    const listBucketsForDate = vi.fn().mockResolvedValue([bucket('a')]);
    const rebuildBucket = vi.fn().mockResolvedValue('id');
    const rebuildBucketForEvent = vi.fn();
    const repo = makeRepo({ listBucketsForDate, rebuildBucket, rebuildBucketForEvent });

    await reconcileDailyBucketsForDate('2026-07-17', { dailyRollupRepository: repo, logger: vi.fn() }, 50);

    // The day-level path only ever calls listBucketsForDate + rebuildBucket —
    // it has no other way to touch raw ai_usage_events rows.
    expect(rebuildBucketForEvent).not.toHaveBeenCalled();
  });

  it('stops immediately when the first page is empty', async () => {
    const listBucketsForDate = vi.fn().mockResolvedValue([]);
    const repo = makeRepo({ listBucketsForDate });

    const outcome = await reconcileDailyBucketsForDate('2026-01-01', { dailyRollupRepository: repo, logger: vi.fn() });

    expect(listBucketsForDate).toHaveBeenCalledTimes(1);
    expect(outcome.bucketsProcessed).toBe(0);
    expect(outcome.lastBucketKey).toBeNull();
  });
});

// ── reconcileDailyBucketsForDate — per-bucket failure isolation ───────────────

describe('reconcileDailyBucketsForDate — failure isolation', () => {
  it('one failing bucket does not stop the rest, and is counted separately', async () => {
    const listBucketsForDate = vi.fn().mockResolvedValue([bucket('a'), bucket('b'), bucket('c')]);
    const rebuildBucket = vi.fn()
      .mockResolvedValueOnce('id-a')
      .mockRejectedValueOnce(new Error('advisory lock timeout'))
      .mockResolvedValueOnce('id-c');
    const repo = makeRepo({ listBucketsForDate, rebuildBucket });
    const logCalls: unknown[] = [];

    const outcome = await reconcileDailyBucketsForDate(
      '2026-07-17',
      { dailyRollupRepository: repo, logger: (event, data) => logCalls.push({ event, data }) },
    );

    expect(rebuildBucket).toHaveBeenCalledTimes(3);
    expect(outcome.bucketsProcessed).toBe(2);
    expect(outcome.bucketsFailed).toBe(1);
    expect(logCalls).toHaveLength(1);
    expect((logCalls[0] as any).event).toBe('gateway.dailyRollup.bucketFailed');
  });

  it('logged failure never contains raw error internals beyond sanitized fields', async () => {
    const repo = makeRepo({
      listBucketsForDate: vi.fn().mockResolvedValue([bucket('a')]),
      rebuildBucket: vi.fn().mockRejectedValue(new Error('token=sk-should-not-leak')),
    });
    const logCalls: Array<{ event: string; data?: Record<string, unknown> }> = [];

    await reconcileDailyBucketsForDate('2026-07-17', { dailyRollupRepository: repo, logger: (e, d) => logCalls.push({ event: e, data: d }) });

    expect(JSON.stringify(logCalls)).not.toContain('sk-should-not-leak');
  });
});
