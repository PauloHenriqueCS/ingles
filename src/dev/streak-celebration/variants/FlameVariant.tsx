/**
 * Variant A — "Chama / Sequência".
 * Emerald streak ring (echoing the Home streak ring) with a flame at its heart,
 * the day count animating up, and a burst of sparks. Energetic, achievement-y.
 */
import { motion } from 'framer-motion';
import { Flame, Trophy } from 'lucide-react';
import type { StreakCelebrationConfig } from '../streakCelebrationTypes';
import { AmbientGlow, CountUp, Sparks, accentFor } from './shared';

const SIZE = 264;
const R = 112;
const C = 2 * Math.PI * R;

export function FlameVariant({
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
      <Sparks color={accent.from} reduced={reduced} count={14} radius={140} delayMs={220} />

      {/* Emerald progress ring */}
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="absolute inset-0 -rotate-90">
        <circle cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke="rgba(148,163,184,0.15)" strokeWidth={10} />
        <motion.circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          fill="none"
          stroke={accent.ring}
          strokeWidth={10}
          strokeLinecap="round"
          strokeDasharray={C}
          initial={{ strokeDashoffset: reduced ? C * 0.12 : C }}
          animate={{ strokeDashoffset: C * 0.12 }}
          transition={{ duration: reduced ? 0 : 1.0, delay: reduced ? 0 : 0.15, ease: [0.16, 1, 0.3, 1] }}
          style={{ filter: `drop-shadow(0 0 6px ${accent.ring})` }}
        />
      </svg>

      {/* Center content */}
      <div className="relative z-10 flex flex-col items-center justify-center">
        <motion.div
          initial={{ scale: 0, rotate: -12, opacity: 0 }}
          animate={{ scale: 1, rotate: 0, opacity: 1 }}
          transition={reduced ? { duration: 0.25 } : { type: 'spring', stiffness: 260, damping: 16, delay: 0.1 }}
        >
          <motion.div
            animate={reduced ? undefined : { scale: [1, 1.08, 1], rotate: [0, -3, 3, 0] }}
            transition={reduced ? undefined : { duration: 1.6, repeat: Infinity, ease: 'easeInOut', delay: 0.6 }}
            style={{ filter: `drop-shadow(0 4px 12px ${accent.glow})` }}
          >
            {isRecord ? (
              <Trophy size={40} strokeWidth={2.25} style={{ color: accent.from }} />
            ) : (
              <Flame size={44} strokeWidth={2.25} style={{ color: accent.from }} fill={accent.to} />
            )}
          </motion.div>
        </motion.div>

        <CountUp
          value={config.days}
          reduced={reduced}
          className="mt-1 text-6xl font-extrabold leading-none text-slate-50 tabular-nums"
        />
        <span className="mt-1 text-sm font-semibold tracking-wide" style={{ color: accent.text }}>
          {config.days === 1 ? 'dia' : 'dias'}
        </span>
      </div>
    </div>
  );
}
