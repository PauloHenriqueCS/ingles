import { useEffect, useRef } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import Lottie, { type LottieRefCurrentProps } from 'lottie-react';
import { Check, Trophy, Flame } from 'lucide-react';
import { useCurriculumFocus } from '../hooks/useCurriculumFocus';
import { celebrationUiStrings } from '../i18n/celebrationUiStrings';
import { playActivityCompleteSound, playDayCompleteSound } from './celebrationSound';
import { triggerActivityHaptic, triggerDayCompleteHaptic } from './celebrationHaptics';
import { trackCelebrationShown } from './celebrationAnalytics';
import { CELEBRATION_TIMING } from './celebrationTiming';
import activityLottie from './assets/lottie/activity-complete.json';
import dayLottie from './assets/lottie/day-complete.json';
import type { Celebration } from './celebration-types';

interface Props {
  celebration: Celebration;
  /**
   * Called when the on-screen HOLD ends and the EXIT should begin. The host sets
   * this celebration inactive; AnimatePresence then plays the exit variant before
   * unmounting. So total on-screen time ≈ (hold) + (exit duration).
   */
  onExpire: () => void;
}

export function CelebrationOverlay({ celebration, onExpire }: Props) {
  const focus = useCurriculumFocus();
  const s = celebrationUiStrings(focus.data?.interfaceLanguage);
  const reduced = useReducedMotion() ?? false;
  const firedRef = useRef(false);
  const lottieRef = useRef<LottieRefCurrentProps>(null);

  const isDay = celebration.type === 'day-complete';
  const t = isDay ? CELEBRATION_TIMING['day-complete'] : CELEBRATION_TIMING['activity-complete'];

  // Fire sound + haptics + observability once, at the animation's impact moment,
  // then schedule the exit. Timers are always (re)armed on setup and cleared on
  // cleanup, so React StrictMode's setup→cleanup→setup can't leave it stuck.
  useEffect(() => {
    let impactTimer: ReturnType<typeof setTimeout>;
    if (!firedRef.current) {
      firedRef.current = true;
      trackCelebrationShown(celebration);
      impactTimer = setTimeout(() => {
        if (isDay) {
          playDayCompleteSound();
          triggerDayCompleteHaptic();
        } else {
          // DIAGNOSTIC (conversation freeze): after two failed fixes on the
          // audio-timing/release theory, isolate the ONE remaining variable —
          // is the freeze the SOUND or the Lottie render? Here we skip ONLY the
          // sound for the conversation activity (animation + haptic still play).
          // If the freeze stops → it's the sound (AudioManager mode conflict) and
          // we restore it via a safe path next. If it still freezes → it's the
          // render, and conversation switches to the lightweight static variant.
          const isConversation =
            celebration.type === 'activity-complete' && celebration.activityType === 'conversation';
          if (!isConversation) playActivityCompleteSound();
          triggerActivityHaptic();
        }
      }, t.impactMs);
    }
    const holdTimer = setTimeout(onExpire, t.holdMs);
    return () => {
      clearTimeout(impactTimer);
      clearTimeout(holdTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Speed the Lottie so its meaningful reveal fits inside the on-screen hold.
  useEffect(() => {
    lottieRef.current?.setSpeed(t.lottieSpeed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const heroSize = isDay ? 260 : 220;

  // Text choreography (framer stagger). Reduced motion → opacity only, no rise.
  const textItem = (delay: number) =>
    reduced
      ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.2, delay: delay * 0.5 } }
      : {
          initial: { opacity: 0, y: 10 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.38, delay, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] },
        };

  const ariaLabel = isDay
    ? s.dayCompleteAria
    : s.activityAria((celebration as Extract<Celebration, { type: 'activity-complete' }>).activityType);

  return (
    <motion.div
      className="fixed inset-0 z-[60] flex items-center justify-center p-6"
      role="alertdialog"
      aria-modal="true"
      aria-live="assertive"
      aria-label={ariaLabel}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: isDay ? 0.34 : 0.26, ease: 'easeOut' }}
    >
      <div className="absolute inset-0 bg-slate-950/85 backdrop-blur-md" aria-hidden="true" />

      <motion.div
        className="relative flex flex-col items-center text-center"
        initial={reduced ? { opacity: 0 } : { scale: 0.82, opacity: 0 }}
        animate={reduced ? { opacity: 1 } : { scale: 1, opacity: 1 }}
        exit={reduced ? { opacity: 0 } : { scale: 0.92, opacity: 0 }}
        transition={
          reduced
            ? { duration: 0.22 }
            : { type: 'spring', stiffness: 260, damping: 20, mass: 0.9, delay: t.contentDelayMs / 1000 }
        }
      >
        {/* Hero animation */}
        <div
          className="relative flex items-center justify-center"
          style={{ width: heroSize, height: heroSize }}
          aria-hidden="true"
        >
          {reduced ? (
            // Reduced motion: a calm static confirmation — no Lottie particles.
            <div
              className="flex items-center justify-center rounded-full shadow-2xl"
              style={{
                width: heroSize * 0.5,
                height: heroSize * 0.5,
                background: isDay
                  ? 'linear-gradient(145deg,#f59e0b,#f97316)'
                  : 'linear-gradient(145deg,#10b981,#14b8a6)',
              }}
            >
              {isDay ? (
                <Trophy style={{ width: 46, height: 46, color: '#fff' }} strokeWidth={2.25} />
              ) : (
                <Check style={{ width: 46, height: 46, color: '#fff' }} strokeWidth={3} />
              )}
            </div>
          ) : (
            <Lottie
              lottieRef={lottieRef}
              animationData={isDay ? dayLottie : activityLottie}
              loop={false}
              autoplay
              style={{ width: heroSize, height: heroSize }}
              rendererSettings={{ preserveAspectRatio: 'xMidYMid meet' }}
            />
          )}
        </div>

        {/* Text */}
        {isDay ? (
          <div className="mt-2 flex flex-col items-center gap-1.5">
            <motion.h2 className="text-2xl font-bold text-slate-50" {...textItem(t.titleDelay)}>
              {s.dayCompleteTitle}
            </motion.h2>
            <motion.p className="text-sm text-slate-300" {...textItem(t.subDelay)}>
              {s.dayCompleteSubtitle}
            </motion.p>
            {typeof (celebration as Extract<Celebration, { type: 'day-complete' }>).streakDays ===
              'number' &&
              ((celebration as Extract<Celebration, { type: 'day-complete' }>).streakDays as number) >
                0 && (
                <motion.p
                  className="mt-1 flex items-center gap-1.5 text-base font-semibold text-amber-300"
                  {...textItem(t.streakDelay ?? t.subDelay)}
                >
                  <Flame className="w-4 h-4" aria-hidden="true" />
                  <motion.span
                    animate={reduced ? undefined : { scale: [1, 1.14, 1] }}
                    transition={reduced ? undefined : { duration: 0.5, delay: (t.streakDelay ?? 0) + 0.1 }}
                  >
                    {s.streakLine(
                      (celebration as Extract<Celebration, { type: 'day-complete' }>)
                        .streakDays as number,
                    )}
                  </motion.span>
                </motion.p>
              )}
          </div>
        ) : (
          <div className="mt-1 flex flex-col items-center gap-1">
            <motion.h2 className="text-xl font-bold text-slate-50" {...textItem(t.titleDelay)}>
              {s.activityTitle(
                (celebration as Extract<Celebration, { type: 'activity-complete' }>).activityType,
              )}
            </motion.h2>
            {typeof (celebration as Extract<Celebration, { type: 'activity-complete' }>)
              .completedCount === 'number' &&
              typeof (celebration as Extract<Celebration, { type: 'activity-complete' }>)
                .totalCount === 'number' &&
              ((celebration as Extract<Celebration, { type: 'activity-complete' }>)
                .totalCount as number) > 0 && (
                <motion.p className="text-sm text-slate-300" {...textItem(t.subDelay)}>
                  {s.activityProgress(
                    (celebration as Extract<Celebration, { type: 'activity-complete' }>)
                      .completedCount as number,
                    (celebration as Extract<Celebration, { type: 'activity-complete' }>)
                      .totalCount as number,
                  )}
                </motion.p>
              )}
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
