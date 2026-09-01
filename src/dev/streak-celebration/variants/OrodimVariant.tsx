/**
 * Variant C — "Orodim premium".
 * Aligned to the brand's aurora (emerald → sky → indigo, matching the logo).
 * Elegant expanding halos, a soft gradient orb holding the day count, a Sparkles
 * accent and calm rising particles (growth). Less gamified, more premium.
 */
import { motion } from 'framer-motion';
import { Sparkles } from 'lucide-react';
import type { StreakCelebrationConfig } from '../streakCelebrationTypes';
import { CountUp } from './shared';

const SIZE = 264;
const BRAND = 'linear-gradient(140deg, #10b981 0%, #22d3ee 45%, #6366f1 100%)';

/** Concentric halos that expand and fade — a calm, premium pulse. */
function Halos({ reduced }: { reduced: boolean }) {
  if (reduced) return null;
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <motion.div
          key={i}
          className="absolute rounded-full"
          style={{ width: 150, height: 150, border: '1.5px solid rgba(34,211,238,0.5)' }}
          initial={{ scale: 0.7, opacity: 0.6 }}
          animate={{ scale: 1.9, opacity: 0 }}
          transition={{ duration: 2.2, delay: 0.2 + i * 0.5, ease: 'easeOut', repeat: Infinity, repeatDelay: 0.4 }}
        />
      ))}
    </div>
  );
}

/** A few soft dots drifting upward — quiet sense of growth/progress. */
function RisingDots({ reduced }: { reduced: boolean }) {
  if (reduced) return null;
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {Array.from({ length: 7 }).map((_, i) => {
        const left = 18 + ((i * 53) % 64);
        const size = 4 + (i % 3) * 2;
        return (
          <motion.span
            key={i}
            className="absolute rounded-full"
            style={{ left: `${left}%`, bottom: 24, width: size, height: size, background: 'rgba(125,211,252,0.9)' }}
            initial={{ y: 0, opacity: 0 }}
            animate={{ y: -150, opacity: [0, 0.9, 0] }}
            transition={{ duration: 2.4, delay: 0.4 + i * 0.18, ease: 'easeOut', repeat: Infinity, repeatDelay: 0.3 }}
          />
        );
      })}
    </div>
  );
}

export function OrodimVariant({
  config,
  reduced,
}: {
  config: StreakCelebrationConfig;
  reduced: boolean;
}) {
  return (
    <div className="relative flex items-center justify-center" style={{ width: SIZE, height: SIZE }}>
      {/* Ambient brand glow */}
      <motion.div
        className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
        aria-hidden="true"
        style={{ width: 420, height: 420, background: 'radial-gradient(circle, rgba(34,211,238,0.35) 0%, rgba(99,102,241,0.12) 45%, transparent 68%)' }}
        initial={{ opacity: 0, scale: 0.7 }}
        animate={reduced ? { opacity: 0.6, scale: 1 } : { opacity: [0, 0.9, 0.6], scale: [0.7, 1.05, 1] }}
        transition={{ duration: reduced ? 0.3 : 1.2, ease: 'easeOut' }}
      />

      <Halos reduced={reduced} />
      <RisingDots reduced={reduced} />

      {/* Gradient orb with the day count */}
      <motion.div
        className="relative z-10 flex flex-col items-center justify-center rounded-full shadow-2xl"
        style={{ width: 150, height: 150, background: BRAND }}
        initial={reduced ? { opacity: 0 } : { scale: 0.6, opacity: 0 }}
        animate={reduced ? { opacity: 1 } : { scale: 1, opacity: 1 }}
        transition={reduced ? { duration: 0.28 } : { type: 'spring', stiffness: 220, damping: 18, delay: 0.1 }}
      >
        {/* inner soft vignette for depth */}
        <div className="absolute inset-0 rounded-full" style={{ boxShadow: 'inset 0 8px 20px rgba(255,255,255,0.25), inset 0 -12px 24px rgba(15,23,42,0.35)' }} aria-hidden="true" />
        <motion.div
          className="relative"
          initial={{ y: 6, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.4, delay: reduced ? 0.1 : 0.35 }}
        >
          <Sparkles size={22} strokeWidth={2.25} style={{ color: 'rgba(255,255,255,0.95)' }} className="mx-auto" />
        </motion.div>
        <CountUp value={config.days} reduced={reduced} delayMs={350} className="relative text-5xl font-extrabold leading-none text-white tabular-nums drop-shadow" />
        <span className="relative text-xs font-semibold tracking-widest text-white/85">{config.days === 1 ? 'DIA' : 'DIAS'}</span>
      </motion.div>
    </div>
  );
}
