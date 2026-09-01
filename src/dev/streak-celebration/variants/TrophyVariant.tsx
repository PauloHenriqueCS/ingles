/**
 * Variant B — "Troféu / Recorde".
 * REUSES the existing Trophy Lottie (`day-complete.json`) as the hero, with a
 * premium gold treatment: ambient glow, a slow shimmer sweep over a day-count
 * badge. Slower, more "you beat your own mark" than gamified.
 *
 * Reuses the exact lottie-web safety pattern from the shipped CelebrationOverlay:
 *   - a FRESH deep clone of the animationData per mount (lottie-web MUTATES it),
 *   - explicit stop()+destroy() on unmount (otherwise instances accumulate and
 *     eventually freeze the tab).
 */
import { useEffect, useMemo, useRef } from 'react';
import { motion } from 'framer-motion';
import Lottie, { type LottieRefCurrentProps } from 'lottie-react';
import { Trophy } from 'lucide-react';
import dayLottie from '../../../celebration/assets/lottie/day-complete.json';
import type { StreakCelebrationConfig } from '../streakCelebrationTypes';
import { AmbientGlow, CountUp, accentFor } from './shared';

const SIZE = 240;

export function TrophyVariant({
  config,
  reduced,
}: {
  config: StreakCelebrationConfig;
  reduced: boolean;
}) {
  const accent = accentFor(config.type);
  const lottieRef = useRef<LottieRefCurrentProps>(null);

  // Fresh clone each mount — lottie-web writes computed keyframes back onto the
  // object it is handed; sharing the import would compound and freeze the tab.
  const animationData = useMemo(() => JSON.parse(JSON.stringify(dayLottie)), []);

  useEffect(() => {
    lottieRef.current?.setSpeed(0.9);
    return () => {
      try {
        lottieRef.current?.stop();
        lottieRef.current?.destroy();
      } catch {
        /* teardown must never throw */
      }
    };
  }, []);

  return (
    <div className="relative flex flex-col items-center justify-center" style={{ width: SIZE + 40 }}>
      <div className="relative flex items-center justify-center" style={{ width: SIZE, height: SIZE }}>
        <AmbientGlow color={accent.glow} reduced={reduced} />
        {reduced ? (
          <div
            className="flex items-center justify-center rounded-full shadow-2xl"
            style={{ width: SIZE * 0.5, height: SIZE * 0.5, background: `linear-gradient(145deg,${accent.from},${accent.to})` }}
          >
            <Trophy size={52} strokeWidth={2.25} style={{ color: '#fff' }} />
          </div>
        ) : (
          <Lottie
            lottieRef={lottieRef}
            animationData={animationData}
            loop={false}
            autoplay
            style={{ width: SIZE, height: SIZE }}
            rendererSettings={{ preserveAspectRatio: 'xMidYMid meet' }}
          />
        )}
      </div>

      {/* Gold day-count badge with a shimmer sweep */}
      <motion.div
        className="relative mt-1 overflow-hidden rounded-full px-5 py-2"
        style={{
          background: 'rgba(245,158,11,0.12)',
          border: `1px solid ${accent.ring}`,
          boxShadow: `0 0 20px ${accent.glow}`,
        }}
        initial={reduced ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.9 }}
        animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
        transition={reduced ? { duration: 0.25, delay: 0.2 } : { type: 'spring', stiffness: 240, damping: 20, delay: 0.7 }}
      >
        {!reduced && (
          <motion.span
            className="pointer-events-none absolute inset-0"
            style={{ background: 'linear-gradient(100deg, transparent 30%, rgba(255,255,255,0.35) 50%, transparent 70%)' }}
            initial={{ x: '-120%' }}
            animate={{ x: '120%' }}
            transition={{ duration: 1.1, delay: 1.1, ease: 'easeInOut' }}
          />
        )}
        <span className="relative flex items-baseline gap-1 font-bold" style={{ color: accent.text }}>
          <CountUp value={config.days} reduced={reduced} delayMs={750} className="text-2xl tabular-nums" />
          <span className="text-sm font-semibold">{config.days === 1 ? 'dia' : 'dias'}</span>
        </span>
      </motion.div>
    </div>
  );
}
