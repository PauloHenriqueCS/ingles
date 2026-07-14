/**
 * Deterministic pseudo-random number generator (mulberry32 algorithm).
 * Same seed always produces the same sequence.
 * Never use Math.random() in planner domain code.
 */

export class DeterministicRandom {
  private state: number;

  constructor(seed: string | number) {
    this.state = typeof seed === 'string' ? hashString(seed) : seed >>> 0;
    // Warm up to avoid weak initial values
    this.next();
    this.next();
  }

  /** Returns a float in [0, 1). */
  next(): number {
    let s = (this.state += 0x6d2b79f5);
    s = Math.imul(s ^ (s >>> 15), s | 1);
    s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
    this.state = s;
    return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
  }

  /** Returns an integer in [0, n). */
  nextInt(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Shuffles array in-place using Fisher-Yates. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.nextInt(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** Picks one element from array. */
  pick<T>(arr: readonly T[]): T {
    return arr[this.nextInt(arr.length)];
  }

  /** Picks n elements from array without replacement. */
  sample<T>(arr: readonly T[], n: number): T[] {
    const copy = arr.slice();
    this.shuffle(copy);
    return copy.slice(0, n);
  }
}

function hashString(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** Creates a seed from userId + date string (YYYY-MM-DD) for daily reproducibility. */
export function buildDailyPlanSeed(userId: string, date: string): string {
  return `${userId}:${date}`;
}

/** Creates a seed from userId + an explicit nonce (regeneration index). */
export function buildRegenerationSeed(userId: string, nonce: number): string {
  return `${userId}:regen:${nonce}`;
}
