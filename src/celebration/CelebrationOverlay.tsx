import { useEffect, useMemo, useRef, useState } from 'react';
import { Flame } from 'lucide-react';
import { useCurriculumFocus } from '../hooks/useCurriculumFocus';
import { celebrationUiStrings } from '../i18n/celebrationUiStrings';
import { prefersReducedMotion } from './celebrationPrefs';
import { playActivityCompleteSound, playDayCompleteSound } from './celebrationSound';
import { triggerActivityHaptic, triggerDayCompleteHaptic } from './celebrationHaptics';
import { trackCelebrationShown } from './celebrationAnalytics';
import type { Celebration } from './celebration-types';

interface Props {
  celebration: Celebration;
  /** Called when the celebration has fully played out; the host dequeues it. */
  onDone: () => void;
}

// Total on-screen lifetime (enter + hold + exit) and how long the exit fade is.
const TIMING = {
  'activity-complete': { total: 950, exit: 240 },
  'day-complete': { total: 1500, exit: 320 },
} as const;

const PARTICLE_COLORS = ['#34d399', '#fbbf24', '#38bdf8', '#a78bfa', '#f472b6'];

interface ParticleStyle extends React.CSSProperties {
  '--dx': string;
  '--dy': string;
  '--rot': string;
  '--delay': string;
}

/** Deterministic burst layout (no randomness) so it renders identically & is testable. */
function buildParticles(count: number, radius: number): ParticleStyle[] {
  return Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2;
    const spread = radius * (0.7 + ((i % 3) * 0.15));
    return {
      '--dx': `${Math.cos(angle) * spread}px`,
      '--dy': `${Math.sin(angle) * spread}px`,
      '--rot': `${(i % 2 === 0 ? 1 : -1) * (120 + (i % 4) * 40)}deg`,
      '--delay': `${(i % 5) * 24}ms`,
      background: PARTICLE_COLORS[i % PARTICLE_COLORS.length],
    };
  });
}

export function CelebrationOverlay({ celebration, onDone }: Props) {
  const focus = useCurriculumFocus();
  const s = celebrationUiStrings(focus.data?.interfaceLanguage);
  const [reduced] = useState(prefersReducedMotion);
  const [phase, setPhase] = useState<'enter' | 'exit'>('enter');
  const firedRef = useRef(false);

  const isDay = celebration.type === 'day-complete';
  const timing = isDay ? TIMING['day-complete'] : TIMING['activity-complete'];

  // Fire sound + haptics + observability exactly once (firedRef survives
  // StrictMode's dev double-invoke). The exit/dismiss timers are ALWAYS armed on
  // setup and cleared on cleanup, so a StrictMode setup→cleanup→setup cycle
  // re-arms them instead of leaving the overlay stuck.
  useEffect(() => {
    if (!firedRef.current) {
      firedRef.current = true;
      if (isDay) {
        playDayCompleteSound();
        triggerDayCompleteHaptic();
      } else {
        playActivityCompleteSound();
        triggerActivityHaptic();
      }
      trackCelebrationShown(celebration);
    }

    const exitTimer = setTimeout(() => setPhase('exit'), timing.total - timing.exit);
    const doneTimer = setTimeout(onDone, timing.total);
    return () => {
      clearTimeout(exitTimer);
      clearTimeout(doneTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const particles = useMemo(
    () => (reduced ? [] : buildParticles(isDay ? 16 : 8, isDay ? 150 : 96)),
    [reduced, isDay],
  );

  const ariaLabel = isDay
    ? s.dayCompleteAria
    : s.activityAria((celebration as Extract<Celebration, { type: 'activity-complete' }>).activityType);

  return (
    <div
      className="celebration-overlay fixed inset-0 z-[60] flex items-center justify-center p-6"
      style={{ opacity: phase === 'exit' ? 0 : 1, transition: `opacity ${timing.exit}ms ease-out` }}
      role="alertdialog"
      aria-modal="true"
      aria-live="assertive"
      aria-label={ariaLabel}
    >
      {/* Backdrop — a soft dark scrim that matches the app's slate theme. */}
      <div
        className="absolute inset-0 bg-slate-950/85 backdrop-blur-md"
        aria-hidden="true"
      />

      <div
        className={`relative flex flex-col items-center text-center ${
          reduced ? '' : isDay ? 'celebration-pop-strong' : 'celebration-pop'
        }`}
      >
        {/* Central medallion */}
        <div className="relative flex items-center justify-center">
          {/* Glow */}
          <div
            className={`absolute rounded-full ${reduced ? '' : 'celebration-glow'}`}
            aria-hidden="true"
            style={{
              width: isDay ? 180 : 132,
              height: isDay ? 180 : 132,
              background: isDay
                ? 'radial-gradient(circle, rgba(251,191,36,0.45) 0%, rgba(251,146,60,0.15) 45%, transparent 70%)'
                : 'radial-gradient(circle, rgba(52,211,153,0.42) 0%, rgba(20,184,166,0.12) 45%, transparent 70%)',
            }}
          />

          {/* Particles / confetti */}
          {particles.map((style, i) => (
            <span
              key={i}
              aria-hidden="true"
              className="celebration-particle"
              style={{
                ...style,
                width: isDay ? 9 : 6,
                height: isDay ? 14 : 6,
                borderRadius: isDay ? 2 : 9999,
              }}
            />
          ))}

          {/* Icon disc */}
          <div
            className="relative flex items-center justify-center rounded-full shadow-2xl"
            style={{
              width: isDay ? 104 : 88,
              height: isDay ? 104 : 88,
              background: isDay
                ? 'linear-gradient(145deg, #f59e0b, #f97316)'
                : 'linear-gradient(145deg, #10b981, #14b8a6)',
            }}
          >
            {isDay ? (
              <Flame
                className={reduced ? '' : 'celebration-flame'}
                style={{ width: 52, height: 52, color: '#fff' }}
                strokeWidth={2.25}
                aria-hidden="true"
              />
            ) : (
              <svg
                viewBox="0 0 52 52"
                style={{ width: 48, height: 48 }}
                fill="none"
                aria-hidden="true"
              >
                <path
                  className={reduced ? undefined : 'celebration-check'}
                  d="M14 27 l8 8 l16 -18"
                  stroke="#ffffff"
                  strokeWidth={5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </div>
        </div>

        {/* Text */}
        {isDay ? (
          <div className="mt-6 flex flex-col items-center gap-1.5">
            <h2
              className={`text-2xl font-bold text-slate-50 ${reduced ? '' : 'celebration-rise-1'}`}
            >
              {s.dayCompleteTitle}
            </h2>
            <p className={`text-sm text-slate-300 ${reduced ? '' : 'celebration-rise-2'}`}>
              {s.dayCompleteSubtitle}
            </p>
            {typeof (celebration as Extract<Celebration, { type: 'day-complete' }>).streakDays ===
              'number' &&
              ((celebration as Extract<Celebration, { type: 'day-complete' }>).streakDays as number) >
                0 && (
                <p
                  className={`mt-1 text-base font-semibold text-amber-300 ${
                    reduced ? '' : 'celebration-rise-3'
                  }`}
                >
                  {s.streakLine(
                    (celebration as Extract<Celebration, { type: 'day-complete' }>)
                      .streakDays as number,
                  )}
                </p>
              )}
          </div>
        ) : (
          <div className="mt-5 flex flex-col items-center gap-1">
            <h2
              className={`text-xl font-bold text-slate-50 ${reduced ? '' : 'celebration-rise-1'}`}
            >
              {s.activityTitle(
                (celebration as Extract<Celebration, { type: 'activity-complete' }>).activityType,
              )}
            </h2>
            {typeof (celebration as Extract<Celebration, { type: 'activity-complete' }>)
              .completedCount === 'number' &&
              typeof (celebration as Extract<Celebration, { type: 'activity-complete' }>)
                .totalCount === 'number' &&
              ((celebration as Extract<Celebration, { type: 'activity-complete' }>)
                .totalCount as number) > 0 && (
                <p className={`text-sm text-slate-300 ${reduced ? '' : 'celebration-rise-2'}`}>
                  {s.activityProgress(
                    (celebration as Extract<Celebration, { type: 'activity-complete' }>)
                      .completedCount as number,
                    (celebration as Extract<Celebration, { type: 'activity-complete' }>)
                      .totalCount as number,
                  )}
                </p>
              )}
          </div>
        )}
      </div>
    </div>
  );
}
