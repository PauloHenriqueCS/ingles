/**
 * Small shared building blocks for the streak-celebration preview variants.
 * All motion uses the project's existing framer-motion — no new library.
 */
import { useEffect, useState } from 'react';
import { animate, motion } from 'framer-motion';
import type { StreakCelebrationType } from '../streakCelebrationTypes';

/** Per-situation accent palette (kept together so variants stay consistent). */
export interface Accent {
  /** Main gradient (used for icon fills, number glow). */
  from: string;
  to: string;
  /** Ambient radial-glow color behind the hero. */
  glow: string;
  /** Ring / progress stroke color. */
  ring: string;
  /** Small text accent (e.g. the "dias" label, streak line). */
  text: string;
}

export function accentFor(type: StreakCelebrationType): Accent {
  switch (type) {
    case 'personal_record':
      return { from: '#fbbf24', to: '#f59e0b', glow: 'rgba(245,158,11,0.45)', ring: '#f59e0b', text: '#fcd34d' };
    case 'both':
      return { from: '#fbbf24', to: '#f97316', glow: 'rgba(249,115,22,0.45)', ring: '#fbbf24', text: '#fcd34d' };
    case 'milestone':
    default:
      return { from: '#fb923c', to: '#f97316', glow: 'rgba(249,115,22,0.42)', ring: '#10b981', text: '#fdba74' };
  }
}

/**
 * A number that animates from 0 → `value`. Respects reduced motion (shows the
 * final value immediately). Kept dependency-free (framer `animate`).
 */
export function CountUp({
  value,
  reduced,
  durationMs = 900,
  delayMs = 150,
  className,
}: {
  value: number;
  reduced: boolean;
  durationMs?: number;
  delayMs?: number;
  className?: string;
}) {
  const [display, setDisplay] = useState(reduced ? value : 0);

  useEffect(() => {
    if (reduced) {
      setDisplay(value);
      return;
    }
    setDisplay(0);
    const controls = animate(0, value, {
      duration: durationMs / 1000,
      delay: delayMs / 1000,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => setDisplay(Math.round(v)),
    });
    return () => controls.stop();
  }, [value, reduced, durationMs, delayMs]);

  return <span className={className}>{display}</span>;
}

/**
 * A radial burst of small spark particles. `count` dots fly outward from center,
 * staggered. Deterministic (angle derived from index) so it's reproducible.
 * Renders nothing when reduced-motion is on.
 */
export function Sparks({
  count = 12,
  radius = 130,
  color,
  reduced,
  delayMs = 200,
}: {
  count?: number;
  radius?: number;
  color: string;
  reduced: boolean;
  delayMs?: number;
}) {
  if (reduced) return null;
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => {
        const angle = (i / count) * Math.PI * 2;
        // Vary the throw distance a touch by index for a less mechanical burst.
        const r = radius * (0.72 + ((i * 37) % 100) / 360);
        const x = Math.cos(angle) * r;
        const y = Math.sin(angle) * r;
        const size = 6 + (i % 3) * 3;
        return (
          <motion.span
            key={i}
            className="absolute rounded-full"
            style={{ width: size, height: size, background: color, boxShadow: `0 0 10px ${color}` }}
            initial={{ x: 0, y: 0, scale: 0, opacity: 0 }}
            animate={{ x, y, scale: [0, 1, 0.4], opacity: [0, 1, 0] }}
            transition={{
              duration: 0.95,
              delay: delayMs / 1000 + (i % 4) * 0.03,
              ease: 'easeOut',
            }}
          />
        );
      })}
    </div>
  );
}

/** A soft ambient radial glow behind the hero. */
export function AmbientGlow({ color, reduced }: { color: string; reduced: boolean }) {
  return (
    <motion.div
      className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
      aria-hidden="true"
      style={{ width: 460, height: 460, background: `radial-gradient(circle, ${color} 0%, transparent 62%)` }}
      initial={{ opacity: 0, scale: 0.7 }}
      animate={reduced ? { opacity: 0.55, scale: 1 } : { opacity: [0, 0.85, 0.55], scale: [0.7, 1.08, 1] }}
      transition={{ duration: reduced ? 0.3 : 1.1, ease: 'easeOut' }}
    />
  );
}
