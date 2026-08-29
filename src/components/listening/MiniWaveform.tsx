import { useMemo } from 'react';

/**
 * Horizontal mini-waveform below the circle. Bars are DETERMINISTIC — derived
 * from a stable seed (episode/story id + part index) via a seeded PRNG, not
 * Math.random — so the same audio always renders the same shape and it never
 * "reshuffles" on re-render. Bars up to the current progress are lit
 * (blue → purple); the rest stay dim. Purely decorative (aria-hidden).
 */
interface Props {
  seed: string;
  /** Audio progress, 0..1. */
  progress: number;
  bars?: number;
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export default function MiniWaveform({ seed, progress, bars = 44 }: Props) {
  const heights = useMemo(() => {
    const rnd = mulberry32(hashSeed(seed || 'listening'));
    const arr: number[] = [];
    let prev = 0.5;
    for (let i = 0; i < bars; i++) {
      const v = 0.18 + rnd() * 0.82;
      // Light smoothing so it reads like an audio envelope, not noise.
      prev = prev * 0.4 + v * 0.6;
      arr.push(prev);
    }
    return arr;
  }, [seed, bars]);

  const p = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));

  return (
    <div className="flex h-10 items-center justify-between gap-[2px]" aria-hidden="true">
      {heights.map((h, i) => {
        const filled = (i + 0.5) / bars <= p;
        const hue = i / bars; // 0 (blue) → 1 (purple)
        const r = Math.round(59 + (168 - 59) * hue);
        const g = Math.round(130 + (85 - 130) * hue);
        const b = Math.round(246 + (247 - 246) * hue);
        return (
          <span
            key={i}
            className="flex-1 rounded-full"
            style={{
              height: `${Math.round(h * 100)}%`,
              minWidth: '2px',
              background: filled ? `rgb(${r},${g},${b})` : 'rgba(100,116,139,0.35)',
              boxShadow: filled ? `0 0 4px rgba(${r},${g},${b},0.5)` : 'none',
              transition: 'background 0.2s, box-shadow 0.2s',
            }}
          />
        );
      })}
    </div>
  );
}
