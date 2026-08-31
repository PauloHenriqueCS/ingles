import { useState, useEffect, useCallback } from 'react';
import {
  fetchTutorialStatus,
  markTutorialCompleted,
  markTutorialSkipped,
  type TutorialStatus,
} from '../lib/tutorialProgress';

/**
 * Server-persisted first-run tutorial status (NEVER localStorage) — drives the
 * automatic Home walkthrough trigger. Mirrors usePlacementStatus: `status` is
 * null while unknown/unavailable so the app never blocks nor force-shows the
 * tutorial on a transient failure. A brand-new user with no row resolves to
 * 'pending' (fetchTutorialStatus maps "no row" → 'pending').
 *
 * `complete()` / `skip()` update the status OPTIMISTICALLY (so the push-permission
 * gate and re-trigger guard react immediately) and then persist to the server.
 */
export function useTutorialStatus(userId: string | undefined) {
  const [status, setStatus] = useState<TutorialStatus | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const refresh = useCallback(async () => {
    if (!userId) return;
    try {
      const next = await fetchTutorialStatus();
      setStatus(next);
    } catch {
      setStatus((prev) => prev ?? null);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      setStatus(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    refresh();
  }, [userId, refresh]);

  const complete = useCallback(async () => {
    setStatus('completed');
    try {
      await markTutorialCompleted();
    } catch {
      // Keep the optimistic 'completed' — the user did finish. A failed write
      // just means the server may re-serve it next session (rare, acceptable).
    }
  }, []);

  const skip = useCallback(async () => {
    setStatus('skipped');
    try {
      await markTutorialSkipped();
    } catch {
      // Keep the optimistic 'skipped' — the user chose to skip.
    }
  }, []);

  return { status, loading, refresh, setStatus, complete, skip };
}
