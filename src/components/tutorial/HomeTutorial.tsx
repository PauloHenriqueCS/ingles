import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  PenSquare,
  AudioLines,
  Headphones,
  MessagesSquare,
  GraduationCap,
  CalendarDays,
  History as HistoryIcon,
  TrendingUp,
  Bell,
  Flame,
  ArrowLeft,
  ChevronRight,
} from 'lucide-react';
import { isNativeApp, isPluginAvailable } from '../../lib/runtimeEnvironment';
import { useReducedMotion } from '../listening/useReducedMotion';
import { useCurriculumFocus } from '../../hooks/useCurriculumFocus';
import { tutorialUiStrings } from '../../i18n/tutorialUiStrings';
import { TUTORIAL_STEPS, TUTORIAL_STEP_COUNT } from './tutorialSteps';
import { useSpotlightTarget } from './useSpotlightTarget';
import { computeSpotlightLayout } from './spotlightGeometry';

interface Props {
  /** Whether the walkthrough is active/visible. */
  open: boolean;
  /** Advance past the last step — the user finished the tutorial. */
  onComplete: () => void;
  /** "Pular tutorial" — dismiss immediately from ANY step (§4). */
  onSkip: () => void;
  /**
   * Lets the host (App) route the Android hardware-back button into the tutorial
   * (previous step, or skip on the first step) without a competing native
   * listener. Called with the handler on mount and null on unmount.
   */
  registerBackHandler?: (handler: (() => void) | null) => void;
}

const SCRIM = 'rgba(2, 6, 23, 0.82)'; // slate-950 @ ~82%

function useViewport() {
  const [vp, setVp] = useState(() => ({
    width: typeof window !== 'undefined' ? window.innerWidth : 375,
    height: typeof window !== 'undefined' ? window.innerHeight : 667,
  }));
  useEffect(() => {
    const onResize = () => setVp({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);
  return vp;
}

function lightHaptic() {
  if (!isNativeApp || !isPluginAvailable('Haptics')) return;
  // Lazy import so the web bundle never touches the native plugin.
  import('@capacitor/haptics')
    .then(({ Haptics, ImpactStyle }) => Haptics.impact({ style: ImpactStyle.Light }))
    .catch(() => {});
}

export default function HomeTutorial({ open, onComplete, onSkip, registerBackHandler }: Props) {
  // Resolve the interface language from the same server source the Home uses, so
  // the walkthrough is coherent with the rest of the Home with no extra wiring.
  const focus = useCurriculumFocus();
  const t = tutorialUiStrings(focus.data?.interfaceLanguage);
  const reduced = useReducedMotion();
  const vp = useViewport();

  const [index, setIndex] = useState(0);
  const step = TUTORIAL_STEPS[index];
  const isFirst = index === 0;
  const isLast = index === TUTORIAL_STEP_COUNT - 1;

  const { rect, insets, ready } = useSpotlightTarget(step.anchor, open);

  const cardRef = useRef<HTMLDivElement>(null);
  const [cardHeight, setCardHeight] = useState(220);

  const titleId = useId();
  const bodyId = useId();

  // Reset to the first step whenever the tutorial (re)opens.
  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  // Measure the actual card height so the geometry can place it precisely.
  useLayoutEffect(() => {
    if (!open || !cardRef.current) return;
    const h = cardRef.current.getBoundingClientRect().height;
    if (h > 0 && Math.abs(h - cardHeight) > 1) setCardHeight(h);
  }, [open, index, rect, vp.width, vp.height, cardHeight]);

  const cardWidth = Math.min(360, vp.width - insets.left - insets.right - 24);
  const layout = computeSpotlightLayout(rect, vp, insets, { cardWidth, cardHeight });

  const advance = useCallback(() => {
    if (isLast) {
      onComplete();
      return;
    }
    setIndex((i) => Math.min(i + 1, TUTORIAL_STEP_COUNT - 1));
  }, [isLast, onComplete]);

  const goBack = useCallback(() => {
    setIndex((i) => Math.max(i - 1, 0));
  }, []);

  // Android hardware back: previous step, or skip when already on the first step
  // (never leaves the user stuck, never falls through to app navigation).
  useEffect(() => {
    if (!open || !registerBackHandler) return;
    registerBackHandler(() => {
      if (isFirst) onSkip();
      else goBack();
    });
    return () => registerBackHandler(null);
  }, [open, isFirst, goBack, onSkip, registerBackHandler]);

  // Haptic tick on each step change (native only).
  useEffect(() => {
    if (open) lightHaptic();
  }, [open, index]);

  // Focus management: remember the previously focused element, move focus into
  // the dialog, trap Tab within it, and restore focus on close (§16).
  const overlayRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // Focus the card container on open / step change.
    const raf = requestAnimationFrame(() => cardRef.current?.focus());
    return () => {
      cancelAnimationFrame(raf);
      previouslyFocused?.focus?.();
    };
  }, [open]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onSkip();
        return;
      }
      if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault();
        advance();
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (!isFirst) goBack();
        return;
      }
      if (e.key === 'Tab') {
        // Simple focus trap within the card.
        const focusables = cardRef.current?.querySelectorAll<HTMLElement>(
          'button, [href], [tabindex]:not([tabindex="-1"])',
        );
        if (!focusables || focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const activeEl = document.activeElement as HTMLElement | null;
        if (e.shiftKey && activeEl === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && activeEl === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [advance, goBack, isFirst, onSkip],
  );

  if (!open || !ready) return null;

  const overlayMotion = reduced
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.15 } }
    : { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.25 } };

  const cardMotion = reduced
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.15 } }
    : {
        initial: { opacity: 0, y: 8, scale: 0.98 },
        animate: { opacity: 1, y: 0, scale: 1 },
        transition: { type: 'spring' as const, stiffness: 320, damping: 30 },
      };

  const highlightTransition = reduced ? { duration: 0 } : { type: 'spring' as const, stiffness: 260, damping: 30 };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={overlayRef}
          className="fixed inset-0 z-[70]"
          // pointer-events auto (default) → captures every tap so the underlying
          // Home cannot be activated during the tutorial (§14). The card sits on
          // top and stays interactive; the visual highlight is pointer-events:none.
          data-tour-overlay="true"
          {...overlayMotion}
        >
          {/* Scrim / spotlight. A centered step (no target) dims the whole screen;
              a spotlight step uses a giant box-shadow to darken everything except
              the padded target rectangle. */}
          {layout.highlight ? (
            <motion.div
              aria-hidden="true"
              className="absolute rounded-2xl pointer-events-none ring-2 ring-white/70"
              initial={false}
              animate={{
                top: layout.highlight.top,
                left: layout.highlight.left,
                width: layout.highlight.width,
                height: layout.highlight.height,
              }}
              transition={highlightTransition}
              style={{ boxShadow: `0 0 0 9999px ${SCRIM}` }}
            />
          ) : (
            <div
              aria-hidden="true"
              className="absolute inset-0 pointer-events-none"
              style={{ backgroundColor: SCRIM }}
            />
          )}

          {/* Info card / dialog */}
          <motion.div
            key={step.id}
            ref={cardRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={bodyId}
            aria-label={t.dialogLabel}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            className="absolute rounded-2xl border border-slate-700 bg-slate-800 shadow-2xl outline-none"
            style={{
              left: layout.card.left,
              top: layout.card.top,
              width: layout.card.width,
            }}
            {...cardMotion}
          >
            <div className="p-5">
              {/* Progress row */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-1.5" aria-hidden="true">
                  {TUTORIAL_STEPS.map((s, i) => (
                    <span
                      key={s.id}
                      className={`h-1.5 rounded-full transition-all ${
                        i === index ? 'w-5 bg-violet-500' : 'w-1.5 bg-slate-600'
                      }`}
                    />
                  ))}
                </div>
                <span className="text-[11px] font-medium text-slate-400 tabular-nums">
                  {t.progress(index + 1, TUTORIAL_STEP_COUNT)}
                </span>
              </div>

              <StepContent stepId={step.id} t={t} titleId={titleId} bodyId={bodyId} />

              {/* Controls — primary CTA row (Voltar + gradient CTA) with the
                  always-visible "Pular tutorial" as a discreet link below (§4).
                  The CTA is flex-1 so its label (incl. "Começar a praticar")
                  never wraps to two lines, even on the narrowest phones. */}
              <div className="mt-5 space-y-3">
                <div className="flex items-center gap-2.5">
                  {!isFirst && (
                    <button
                      type="button"
                      onClick={goBack}
                      className="flex-none inline-flex items-center gap-1 rounded-xl px-3.5 py-2.5 text-sm font-semibold text-slate-300 bg-slate-800/60 border border-slate-600/80 hover:bg-slate-700/70 hover:text-slate-100 transition-colors focus:outline-none focus:ring-2 focus:ring-slate-400"
                      data-tour-action="back"
                    >
                      <ArrowLeft className="w-4 h-4 shrink-0" aria-hidden="true" />
                      {t.back}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={advance}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-4 py-2.5 text-sm font-semibold text-white bg-gradient-to-r from-blue-600 via-violet-600 to-fuchsia-600 hover:from-blue-500 hover:via-violet-500 hover:to-fuchsia-500 ring-1 ring-inset ring-white/10 shadow-[0_8px_24px_-8px_rgba(139,92,246,0.7)] transition-all focus:outline-none focus:ring-2 focus:ring-violet-300"
                    data-tour-action={isLast ? 'complete' : 'next'}
                  >
                    {isFirst ? t.step1.cta : isLast ? t.step7.cta : t.next}
                    <ChevronRight className="w-4 h-4 shrink-0" aria-hidden="true" />
                  </button>
                </div>

                <div className="flex justify-center">
                  <button
                    type="button"
                    onClick={onSkip}
                    className="text-xs font-medium text-slate-400 hover:text-slate-200 underline underline-offset-2 decoration-slate-600 transition-colors focus:outline-none focus:ring-2 focus:ring-slate-500 rounded px-2 py-1"
                    data-tour-action="skip"
                  >
                    {t.skip}
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ── Per-step content ──────────────────────────────────────────────────────────

function Title({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="text-lg font-bold text-slate-50 leading-snug">
      {children}
    </h2>
  );
}
function Body({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p id={id} className="mt-2 text-sm text-slate-300 leading-relaxed">
      {children}
    </p>
  );
}

function StepContent({
  stepId,
  t,
  titleId,
  bodyId,
}: {
  stepId: string;
  t: ReturnType<typeof tutorialUiStrings>;
  titleId: string;
  bodyId: string;
}) {
  switch (stepId) {
    case 'welcome':
      return (
        <>
          <Title id={titleId}>{t.step1.title}</Title>
          <Body id={bodyId}>{t.step1.body}</Body>
        </>
      );
    case 'focus':
      return (
        <>
          <Title id={titleId}>{t.step2.title}</Title>
          <Body id={bodyId}>{t.step2.body}</Body>
          <p className="mt-2.5 flex items-center gap-1.5 text-xs text-amber-300/90">
            <Flame className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            {t.step2.streakNote}
          </p>
        </>
      );
    case 'recommended':
      return (
        <>
          <Title id={titleId}>{t.step3.title}</Title>
          <Body id={bodyId}>{t.step3.body}</Body>
        </>
      );
    case 'practices':
      return (
        <>
          <Title id={titleId}>{t.step4.title}</Title>
          <Body id={bodyId}>{t.step4.body}</Body>
          <ul className="mt-3 space-y-2">
            <ModalityItem icon={<PenSquare className="w-4 h-4" />} color="bg-blue-500/20 text-blue-300" name={t.step4.writing.name} desc={t.step4.writing.desc} />
            <ModalityItem icon={<AudioLines className="w-4 h-4" />} color="bg-orange-500/20 text-orange-300" name={t.step4.pronunciation.name} desc={t.step4.pronunciation.desc} />
            <ModalityItem icon={<Headphones className="w-4 h-4" />} color="bg-purple-500/20 text-purple-300" name={t.step4.listening.name} desc={t.step4.listening.desc} />
            <ModalityItem icon={<MessagesSquare className="w-4 h-4" />} color="bg-teal-500/20 text-teal-300" name={t.step4.conversation.name} desc={t.step4.conversation.desc} />
          </ul>
        </>
      );
    case 'errors':
      return (
        <>
          <Title id={titleId}>{t.step5.title}</Title>
          <Body id={bodyId}>{t.step5.body}</Body>
        </>
      );
    case 'progress':
      return (
        <>
          <Title id={titleId}>{t.step6.title}</Title>
          <Body id={bodyId}>{t.step6.body}</Body>
          <ul className="mt-3 space-y-2">
            <MenuItem icon={<GraduationCap className="w-4 h-4" />} label={t.step6.plan.label} desc={t.step6.plan.desc} />
            <MenuItem icon={<CalendarDays className="w-4 h-4" />} label={t.step6.calendar.label} desc={t.step6.calendar.desc} />
            <MenuItem icon={<HistoryIcon className="w-4 h-4" />} label={t.step6.history.label} desc={t.step6.history.desc} />
            <MenuItem icon={<TrendingUp className="w-4 h-4" />} label={t.step6.evolution.label} desc={t.step6.evolution.desc} />
            <MenuItem icon={<Bell className="w-4 h-4" />} label={t.step6.reminder.label} desc={t.step6.reminder.desc} />
          </ul>
        </>
      );
    case 'ready':
      return (
        <>
          <Title id={titleId}>{t.step7.title}</Title>
          <Body id={bodyId}>{t.step7.body}</Body>
        </>
      );
    default:
      return null;
  }
}

function ModalityItem({
  icon,
  color,
  name,
  desc,
}: {
  icon: React.ReactNode;
  color: string;
  name: string;
  desc: string;
}) {
  return (
    <li className="flex items-start gap-2.5">
      <span className={`shrink-0 mt-0.5 grid place-items-center w-7 h-7 rounded-lg ${color}`} aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-slate-100">{name}</span>
        <span className="block text-xs text-slate-400 leading-snug">{desc}</span>
      </span>
    </li>
  );
}

function MenuItem({ icon, label, desc }: { icon: React.ReactNode; label: string; desc: string }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="shrink-0 mt-0.5 text-slate-400" aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0 text-xs leading-snug">
        <span className="font-semibold text-slate-200">{label}: </span>
        <span className="text-slate-400">{desc}</span>
      </span>
    </li>
  );
}
