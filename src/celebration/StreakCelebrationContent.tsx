/**
 * The streak-celebration visual (variant "Confete", chosen by the user): a
 * tasteful confetti burst around the day count, with eyebrow/title/subtitle copy.
 * Rendered by CelebrationOverlay for `type: 'streak'`. Uses the celebration
 * system's existing framer-motion + lucide-react — no new library.
 */
import { useEffect, useState } from 'react';
import { animate, motion } from 'framer-motion';
import { Flame, Trophy } from 'lucide-react';
import { celebrationUiStrings } from '../i18n/celebrationUiStrings';
import type { CelebrationTiming } from './celebrationTiming';
import type { Celebration } from './celebration-types';

type StreakCelebration = Extract<Celebration, { type: 'streak' }>;

const SIZE = 264;
const CONFETTI_COLORS = ['#10b981', '#fbbf24', '#22d3ee', '#fb923c', '#e2e8f0', '#34d399'];

function rnd(i: number, seed: number): number {
  const x = Math.sin(i * 12.9898 + seed * 4.1) * 43758.5453;
  return x - Math.floor(x);
}

function accentFor(kind: StreakCelebration['kind']) {
  return kind === 'milestone'
    ? { from: '#fb923c', to: '#f97316', glow: 'rgba(249,115,22,0.42)', text: '#fdba74' }
    : { from: '#fbbf24', to: '#f59e0b', glow: 'rgba(245,158,11,0.45)', text: '#fcd34d' };
}

function CountUp({ value, reduced, delayMs }: { value: number; reduced: boolean; delayMs: number }) {
  const [display, setDisplay] = useState(reduced ? value : 0);
  useEffect(() => {
    if (reduced) {
      setDisplay(value);
      return;
    }
    setDisplay(0);
    const controls = animate(0, value, {
      duration: 0.9,
      delay: delayMs / 1000,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => setDisplay(Math.round(v)),
    });
    return () => controls.stop();
  }, [value, reduced, delayMs]);
  return <span className="text-6xl font-extrabold leading-none text-slate-50 tabular-nums">{display}</span>;
}

export function StreakCelebrationContent({
  celebration,
  reduced,
  timing,
  interfaceLanguage,
}: {
  celebration: StreakCelebration;
  reduced: boolean;
  timing: CelebrationTiming;
  interfaceLanguage: string | null | undefined;
}) {
  const s = celebrationUiStrings(interfaceLanguage);
  const accent = accentFor(celebration.kind);
  const isRecord = celebration.kind !== 'milestone';
  const days = celebration.streakDays;
  const dayWord = days === 1 ? 'dia' : 'dias';

  const textItem = (delay: number) =>
    reduced
      ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.2, delay: delay * 0.5 } }
      : {
          initial: { opacity: 0, y: 10 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.4, delay, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] },
        };

  return (
    <>
      {/* Hero: confetti + count-up */}
      <div className="relative flex items-center justify-center" style={{ width: SIZE, height: SIZE }} aria-hidden="true">
        {/* ambient glow */}
        <motion.div
          className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ width: 440, height: 440, background: `radial-gradient(circle, ${accent.glow} 0%, transparent 62%)` }}
          initial={{ opacity: 0, scale: 0.7 }}
          animate={reduced ? { opacity: 0.5, scale: 1 } : { opacity: [0, 0.8, 0.5], scale: [0.7, 1.06, 1] }}
          transition={{ duration: reduced ? 0.3 : 1.0, ease: 'easeOut' }}
        />

        {!reduced &&
          Array.from({ length: 30 }).map((_, i) => {
            const w = 6 + Math.floor(rnd(i, 1) * 4);
            const h = 11 + Math.floor(rnd(i, 2) * 7);
            const ang = rnd(i, 3) * Math.PI * 2;
            const dist = 80 + rnd(i, 4) * 90;
            const x = Math.cos(ang) * dist;
            const y = Math.sin(ang) * dist + 70 + rnd(i, 5) * 70;
            const rot = rnd(i, 6) * 720 - 360;
            const dur = (1000 + rnd(i, 7) * 700) / 1000;
            return (
              <motion.span
                key={i}
                className="absolute"
                style={{ left: '50%', top: '40%', width: w, height: h, background: CONFETTI_COLORS[i % CONFETTI_COLORS.length], borderRadius: 1 }}
                initial={{ x: 0, y: 0, rotate: 0, opacity: 0 }}
                animate={{ x: [0, x * 0.5, x], y: [0, y * 0.4, y], rotate: [0, rot * 0.5, rot], opacity: [0, 1, 0] }}
                transition={{ duration: dur, delay: timing.impactMs / 1000 + rnd(i, 8) * 0.12, times: [0, 0.35, 1], ease: [0.2, 0.7, 0.3, 1] }}
              />
            );
          })}

        <motion.div
          className="relative z-10 flex flex-col items-center"
          initial={reduced ? { opacity: 0 } : { scale: 0.8, opacity: 0 }}
          animate={reduced ? { opacity: 1 } : { scale: 1, opacity: 1 }}
          transition={reduced ? { duration: 0.25 } : { type: 'spring', stiffness: 260, damping: 18, delay: timing.contentDelayMs / 1000 }}
        >
          <div style={{ color: accent.from, filter: `drop-shadow(0 4px 12px ${accent.glow})` }}>
            {isRecord ? (
              <Trophy size={38} strokeWidth={2.25} style={{ color: accent.from }} />
            ) : (
              <Flame size={38} strokeWidth={2.25} style={{ color: accent.from }} fill={accent.to} />
            )}
          </div>
          <CountUp value={days} reduced={reduced} delayMs={timing.impactMs + 40} />
          <span className="mt-1 text-sm font-semibold" style={{ color: accent.text }}>
            {dayWord}
          </span>
        </motion.div>
      </div>

      {/* Copy */}
      <div className="mt-3 flex max-w-sm flex-col items-center gap-1.5 text-center">
        <motion.span
          className="text-xs font-semibold uppercase tracking-[0.18em]"
          style={{ color: accent.text }}
          {...textItem(timing.titleDelay - 0.12)}
        >
          {s.streakEyebrow(celebration.kind)}
        </motion.span>
        <motion.h2 className="text-2xl font-bold text-slate-50" {...textItem(timing.titleDelay)}>
          {s.streakTitle(celebration.kind, days)}
        </motion.h2>
        <motion.p className="text-sm text-slate-300" {...textItem(timing.subDelay)}>
          {s.streakSubtitle(celebration.kind, days, celebration.previousBest)}
        </motion.p>
      </div>
    </>
  );
}
