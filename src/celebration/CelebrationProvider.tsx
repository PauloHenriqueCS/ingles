import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence } from 'framer-motion';
import { CelebrationContext, type CelebrationContextValue } from './CelebrationContext';
import { CelebrationOverlay } from './CelebrationOverlay';
import { resolveActivityCelebration } from './resolveCelebration';
import { createCelebrationDedup } from './celebrationDedup';
import { installCelebrationAudioUnlock } from './celebrationSound';
import { getTodaySP } from '../lib/timezone';
import type { Celebration, CelebrationActivityType } from './celebration-types';

/**
 * Global celebration host. Mounted ONCE, above the whole app (main.tsx), so a
 * celebration overlays every screen and OUTLIVES the navigation that a completion
 * flow may trigger immediately after — the calling screen can fire-and-forget and
 * navigate; the overlay is not tied to that screen's lifecycle.
 *
 * Responsibilities:
 *   - expose the imperative API (notifyActivityCompleted + low-level helpers);
 *   - serialize celebrations through a small queue (never two at once);
 *   - prevent duplicates: rapid double-fires are coalesced, and 'day-complete'
 *     is shown at most ONCE per São Paulo day (survives remounts/reloads within
 *     the tab session).
 */

// Coalesce accidental double-fires of the SAME activity (StrictMode double
// invoke, a doubled event) without suppressing genuinely distinct completions.
const DUP_WINDOW_MS = 4000;

interface QueueItem {
  id: number;
  celebration: Celebration;
}

export function CelebrationProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const idRef = useRef(0);
  const inFlightRef = useRef<Set<string>>(new Set());
  const dedupRef = useRef(
    createCelebrationDedup({
      now: () => Date.now(),
      storage: typeof sessionStorage !== 'undefined' ? sessionStorage : null,
      dayKey: () => getTodaySP(),
      windowMs: DUP_WINDOW_MS,
    }),
  );

  const enqueue = useCallback((celebration: Celebration) => {
    if (celebration.type === 'day-complete') {
      // At most one day-complete per day. Mark BEFORE enqueueing so two
      // near-simultaneous resolutions can't both slip through.
      if (dedupRef.current.dayCompleteAlreadyShown()) return;
      dedupRef.current.markDayCompleteShown();
    }
    idRef.current += 1;
    const item: QueueItem = { id: idRef.current, celebration };
    setQueue((q) => [...q, item]);
  }, []);

  const celebrateActivityComplete = useCallback<
    CelebrationContextValue['celebrateActivityComplete']
  >((payload) => enqueue(payload), [enqueue]);

  const celebrateDayComplete = useCallback<CelebrationContextValue['celebrateDayComplete']>(
    (payload) => enqueue(payload),
    [enqueue],
  );

  const notifyActivityCompleted = useCallback(
    (activity: CelebrationActivityType) => {
      if (dedupRef.current.isDuplicateActivity(activity)) return; // swallow rapid duplicates
      if (inFlightRef.current.has(activity)) return;
      inFlightRef.current.add(activity);

      void resolveActivityCelebration(activity)
        .then((celebration) => enqueue(celebration))
        .catch(() => {
          // Absolute fail-safe: a resolution error still gets a plain
          // activity-complete — the completion is real, only the day math failed.
          enqueue({ type: 'activity-complete', activityType: activity });
        })
        .finally(() => {
          inFlightRef.current.delete(activity);
        });
    },
    [enqueue],
  );

  // Dequeue the current celebration → active becomes null (or the next item),
  // and AnimatePresence plays the exit variant before unmounting.
  const handleExpire = useCallback(() => {
    setQueue((q) => q.slice(1));
  }, []);

  // Prime the audio elements on the first user gesture (autoplay policy), once.
  useEffect(() => {
    installCelebrationAudioUnlock();
  }, []);

  const value = useMemo<CelebrationContextValue>(
    () => ({ notifyActivityCompleted, celebrateActivityComplete, celebrateDayComplete }),
    [notifyActivityCompleted, celebrateActivityComplete, celebrateDayComplete],
  );

  const active = queue[0] ?? null;

  return (
    <CelebrationContext.Provider value={value}>
      {children}
      {/* mode="wait" → the exit animation finishes before any next celebration enters. */}
      <AnimatePresence mode="wait">
        {active && (
          <CelebrationOverlay
            key={active.id}
            celebration={active.celebration}
            onExpire={handleExpire}
          />
        )}
      </AnimatePresence>
    </CelebrationContext.Provider>
  );
}
