/**
 * Pure, dependency-injected de-duplication for celebrations. Extracted from the
 * provider so it is unit-testable in the node test env (no DOM required):
 *
 *   - isDuplicateActivity: coalesces rapid repeat fires of the SAME activity
 *     (React StrictMode double-invoke, a doubled event, a re-render) within a
 *     short window — the first call records "now" and returns false, a second
 *     call inside the window returns true (skip). Distinct activities never
 *     collide.
 *   - day-complete once-per-day: backed by injectable storage keyed by the São
 *     Paulo day, so a day-complete is shown at most once and survives remounts /
 *     reloads within the tab session.
 *
 * The clock and storage are injected so tests can drive time and use an in-memory
 * store; production wires Date.now + sessionStorage + getTodaySP.
 */
export interface DedupOptions {
  now: () => number;
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** Returns the current São Paulo day string (YYYY-MM-DD). */
  dayKey: () => string;
  windowMs: number;
}

export interface CelebrationDedup {
  isDuplicateActivity: (activity: string) => boolean;
  dayCompleteAlreadyShown: () => boolean;
  markDayCompleteShown: () => void;
}

export function createCelebrationDedup(opts: DedupOptions): CelebrationDedup {
  const recent: Record<string, number> = {};

  return {
    isDuplicateActivity(activity: string): boolean {
      const t = opts.now();
      const last = recent[activity];
      // `undefined` means it has never fired — never a duplicate (guarding against
      // treating a default 0 as a real prior fire when the clock is small).
      if (last !== undefined && t - last < opts.windowMs) return true;
      recent[activity] = t;
      return false;
    },
    dayCompleteAlreadyShown(): boolean {
      try {
        return opts.storage?.getItem(`celebration:day-complete:${opts.dayKey()}`) === '1';
      } catch {
        return false;
      }
    },
    markDayCompleteShown(): void {
      try {
        opts.storage?.setItem(`celebration:day-complete:${opts.dayKey()}`, '1');
      } catch {
        /* private mode / unavailable — in-memory serialization still applies */
      }
    },
  };
}
