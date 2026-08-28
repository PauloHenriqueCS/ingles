import { describe, it, expect } from 'vitest';
import { createCelebrationDedup } from '../celebrationDedup';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe('celebrationDedup — rapid duplicate coalescing (re-render / double event)', () => {
  it('a second fire of the same activity inside the window is suppressed', () => {
    let t = 1000;
    const dedup = createCelebrationDedup({
      now: () => t,
      storage: null,
      dayKey: () => '2026-08-28',
      windowMs: 4000,
    });
    expect(dedup.isDuplicateActivity('listening')).toBe(false); // first: shows
    t = 1500;
    expect(dedup.isDuplicateActivity('listening')).toBe(true); // re-render/dup: suppressed
    t = 1800;
    expect(dedup.isDuplicateActivity('listening')).toBe(true); // still within window
  });

  it('the same activity fires again once the window has passed', () => {
    let t = 1000;
    const dedup = createCelebrationDedup({
      now: () => t,
      storage: null,
      dayKey: () => '2026-08-28',
      windowMs: 4000,
    });
    expect(dedup.isDuplicateActivity('writing')).toBe(false);
    t = 6000; // > window
    expect(dedup.isDuplicateActivity('writing')).toBe(false);
  });

  it('distinct activities never collide with each other', () => {
    const t = 1000;
    const dedup = createCelebrationDedup({
      now: () => t,
      storage: null,
      dayKey: () => '2026-08-28',
      windowMs: 4000,
    });
    expect(dedup.isDuplicateActivity('writing')).toBe(false);
    expect(dedup.isDuplicateActivity('listening')).toBe(false);
    expect(dedup.isDuplicateActivity('pronunciation')).toBe(false);
  });
});

describe('celebrationDedup — day-complete once per day (reload / return-to-screen safe)', () => {
  it('a day-complete is shown at most once per São Paulo day', () => {
    const storage = memoryStorage();
    const dedup = createCelebrationDedup({
      now: () => 0,
      storage,
      dayKey: () => '2026-08-28',
      windowMs: 4000,
    });
    expect(dedup.dayCompleteAlreadyShown()).toBe(false);
    dedup.markDayCompleteShown();
    expect(dedup.dayCompleteAlreadyShown()).toBe(true);
  });

  it('a fresh dedup instance (remount/reload) still sees the persisted flag → no re-celebration', () => {
    const storage = memoryStorage();
    const opts = { now: () => 0, storage, dayKey: () => '2026-08-28', windowMs: 4000 };
    createCelebrationDedup(opts).markDayCompleteShown();
    // Simulate a remount/reload: a brand-new instance sharing the same storage.
    expect(createCelebrationDedup(opts).dayCompleteAlreadyShown()).toBe(true);
  });

  it('a new day resets the flag', () => {
    const storage = memoryStorage();
    let day = '2026-08-28';
    const dedup = createCelebrationDedup({
      now: () => 0,
      storage,
      dayKey: () => day,
      windowMs: 4000,
    });
    dedup.markDayCompleteShown();
    expect(dedup.dayCompleteAlreadyShown()).toBe(true);
    day = '2026-08-29';
    expect(dedup.dayCompleteAlreadyShown()).toBe(false);
  });

  it('storage being unavailable never throws (private mode / no storage)', () => {
    const dedup = createCelebrationDedup({
      now: () => 0,
      storage: null,
      dayKey: () => '2026-08-28',
      windowMs: 4000,
    });
    expect(() => dedup.markDayCompleteShown()).not.toThrow();
    expect(dedup.dayCompleteAlreadyShown()).toBe(false);
  });
});
