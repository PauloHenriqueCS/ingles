/**
 * The reusable STREAK CELEBRATION overlay (preview).
 *
 * Full-screen overlay that mirrors the shipped CelebrationOverlay's chrome
 * (fixed inset-0, z-[60], role="alertdialog", slate-950/85 + backdrop-blur) and
 * its patterns (framer-motion choreography, reduced-motion fallbacks, sound +
 * haptics at an impact beat). It renders one of three visual variants and is
 * fully driven by props — no data fetching, context, DB, or streak detection.
 */
import { useEffect, useRef } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { X } from 'lucide-react';
import { streakCopy } from './streakCelebrationCopy';
import { playStreakSound } from './streakCelebrationSound';
import { triggerStreakHaptic } from './streakCelebrationHaptics';
import { accentFor } from './variants/shared';
import { FlameVariant } from './variants/FlameVariant';
import { TrophyVariant } from './variants/TrophyVariant';
import { OrodimVariant } from './variants/OrodimVariant';
import type { StreakCelebrationConfig } from './streakCelebrationTypes';

const IMPACT_MS = 260; // when sound + haptic fire (as the hero pops in)
const DEFAULT_HOLD_MS = 2800; // time on screen before auto-dismiss (mimics real ~1.5–3s)

interface Props {
  config: StreakCelebrationConfig;
  /** Called when the overlay should be removed (auto-dismiss, Esc, backdrop, X). */
  onClose: () => void;
  /** Auto-dismiss after `holdMs`. Off lets you study a frame in the lab. */
  autoDismiss?: boolean;
  holdMs?: number;
  /**
   * Lab-only: force reduced motion on/off to test the accessible fallback
   * without changing the OS setting. When undefined, the OS preference wins.
   */
  reducedOverride?: boolean;
}

export function StreakCelebrationOverlay({
  config,
  onClose,
  autoDismiss = true,
  holdMs = DEFAULT_HOLD_MS,
  reducedOverride,
}: Props) {
  const osReduced = useReducedMotion() ?? false;
  const reduced = reducedOverride ?? osReduced;
  const firedRef = useRef(false);
  const copy = streakCopy(config.type, config.days, config.previousBest);
  const accent = accentFor(config.type);

  // Fire sound + haptics once at the impact beat, then optionally schedule close.
  useEffect(() => {
    let impactTimer: ReturnType<typeof setTimeout> | undefined;
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    if (!firedRef.current) {
      firedRef.current = true;
      impactTimer = setTimeout(() => {
        playStreakSound(config.sound);
        triggerStreakHaptic(config.type);
      }, IMPACT_MS);
    }
    if (autoDismiss) holdTimer = setTimeout(onClose, holdMs);
    return () => {
      if (impactTimer) clearTimeout(impactTimer);
      if (holdTimer) clearTimeout(holdTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc closes (lab convenience; harmless in the real system too).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const Hero =
    config.variant === 'trophy'
      ? TrophyVariant
      : config.variant === 'orodim'
        ? OrodimVariant
        : FlameVariant;

  const textItem = (delay: number) =>
    reduced
      ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.2, delay: delay * 0.5 } }
      : {
          initial: { opacity: 0, y: 10 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.4, delay, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] },
        };

  return (
    <motion.div
      className="fixed inset-0 z-[60] flex items-center justify-center p-6"
      role="alertdialog"
      aria-modal="true"
      aria-live="assertive"
      aria-label={copy.aria}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
    >
      {/* Backdrop — click to dismiss (lab convenience) */}
      <button
        type="button"
        className="absolute inset-0 bg-slate-950/85 backdrop-blur-md"
        aria-label="Fechar celebração"
        onClick={onClose}
      />

      {/* Close (X) */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Fechar"
        className="absolute right-5 top-5 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-slate-800/70 text-slate-300 hover:bg-slate-700 hover:text-white"
      >
        <X size={18} />
      </button>

      <motion.div
        className="relative flex flex-col items-center text-center"
        initial={reduced ? { opacity: 0 } : { scale: 0.85, opacity: 0 }}
        animate={reduced ? { opacity: 1 } : { scale: 1, opacity: 1 }}
        exit={reduced ? { opacity: 0 } : { scale: 0.92, opacity: 0 }}
        transition={reduced ? { duration: 0.22 } : { type: 'spring', stiffness: 260, damping: 20, mass: 0.9 }}
      >
        <div aria-hidden="true">
          <Hero config={config} reduced={reduced} />
        </div>

        <div className="mt-3 flex max-w-sm flex-col items-center gap-1.5">
          <motion.span
            className="text-xs font-semibold uppercase tracking-[0.18em]"
            style={{ color: accent.text }}
            {...textItem(0.5)}
          >
            {copy.eyebrow}
          </motion.span>
          <motion.h2 className="text-2xl font-bold text-slate-50" {...textItem(0.62)}>
            {copy.title}
          </motion.h2>
          <motion.p className="text-sm text-slate-300" {...textItem(0.82)}>
            {copy.subtitle}
          </motion.p>
        </div>
      </motion.div>
    </motion.div>
  );
}
