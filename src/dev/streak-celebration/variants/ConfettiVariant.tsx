/**
 * Variant H — "Confete" (chosen direction).
 * A tasteful confetti burst (falling ribbons, brand + gold palette) around the
 * day count. Uses the project's existing framer-motion — no new library.
 * Deterministic (piece params derived from index) so it's reproducible.
 */
import { motion } from 'framer-motion';
import { Flame, Trophy } from 'lucide-react';
import type { StreakCelebrationConfig } from '../streakCelebrationTypes';
import { AmbientGlow, CountUp, accentFor } from './shared';

const SIZE = 264;
const COLORS = ['#10b981', '#fbbf24', '#22d3ee', '#fb923c', '#e2e8f0', '#34d399'];

/** Deterministic pseudo-random in [0,1) from an index + seed. */
function rnd(i: number, seed: number): number {
  const x = Math.sin(i * 12.9898 + seed * 4.1) * 43758.5453;
  return x - Math.floor(x);
}

export function ConfettiVariant({
  config,
  reduced,
}: {
  config: StreakCelebrationConfig;
  reduced: boolean;
}) {
  const accent = accentFor(config.type);
  const isRecord = config.type !== 'milestone';

  return (
    <div className="relative flex items-center justify-center" style={{ width: SIZE, height: SIZE }}>
      <AmbientGlow color={accent.glow} reduced={reduced} />

      {!reduced &&
        Array.from({ length: 30 }).map((_, i) => {
          const w = 6 + Math.floor(rnd(i, 1) * 4);
          const h = 11 + Math.floor(rnd(i, 2) * 7);
          const ang = rnd(i, 3) * Math.PI * 2;
          const dist = 80 + rnd(i, 4) * 90;
          const x = Math.cos(ang) * dist;
          const y = Math.sin(ang) * dist + 70 + rnd(i, 5) * 70; // gravity bias
          const rot = rnd(i, 6) * 720 - 360;
          const dur = (1000 + rnd(i, 7) * 700) / 1000;
          return (
            <motion.span
              key={i}
              aria-hidden="true"
              className="absolute"
              style={{ left: '50%', top: '40%', width: w, height: h, background: COLORS[i % COLORS.length], borderRadius: 1 }}
              initial={{ x: 0, y: 0, rotate: 0, opacity: 0 }}
              animate={{ x: [0, x * 0.5, x], y: [0, y * 0.4, y], rotate: [0, rot * 0.5, rot], opacity: [0, 1, 0] }}
              transition={{ duration: dur, delay: rnd(i, 8) * 0.12, times: [0, 0.35, 1], ease: [0.2, 0.7, 0.3, 1] }}
            />
          );
        })}

      <motion.div
        className="relative z-10 flex flex-col items-center"
        initial={reduced ? { opacity: 0 } : { scale: 0.8, opacity: 0 }}
        animate={reduced ? { opacity: 1 } : { scale: 1, opacity: 1 }}
        transition={reduced ? { duration: 0.25 } : { type: 'spring', stiffness: 260, damping: 18 }}
      >
        <div style={{ color: accent.from, filter: `drop-shadow(0 4px 12px ${accent.glow})` }}>
          {isRecord ? (
            <Trophy size={38} strokeWidth={2.25} style={{ color: accent.from }} />
          ) : (
            <Flame size={38} strokeWidth={2.25} style={{ color: accent.from }} fill={accent.to} />
          )}
        </div>
        <CountUp value={config.days} reduced={reduced} delayMs={150} className="text-6xl font-extrabold leading-none text-slate-50 tabular-nums" />
        <span className="mt-1 text-sm font-semibold" style={{ color: accent.text }}>
          {config.days === 1 ? 'dia' : 'dias'}
        </span>
      </motion.div>
    </div>
  );
}
