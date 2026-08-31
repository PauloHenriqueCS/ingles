import { useState, useEffect, useCallback } from 'react';
import {
  fetchStudyRoutineStatus,
  markStudyRoutineConfigured,
  type StudyRoutineStatus,
} from '../lib/studyRoutineConfig';

/**
 * Server-persisted "Rotina de estudos" onboarding status (NEVER localStorage) —
 * drives the MANDATORY post-tutorial configuration gate. Mirrors
 * useTutorialStatus / usePlacementStatus: `status` is null while unknown or on a
 * transient failure, so the app never traps the user behind the gate on a flaky
 * read (it re-appears next launch while still unconfigured). A brand-new user
 * with no row resolves to 'unconfigured' (fetchStudyRoutineStatus maps "no row"
 * → 'unconfigured').
 *
 * `markConfigured()` updates the status OPTIMISTICALLY (so the gate releases
 * immediately) and then persists to the server.
 */
export function useStudyRoutineStatus(userId: string | undefined) {
  const [status, setStatus] = useState<StudyRoutineStatus | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const refresh = useCallback(async () => {
    if (!userId) return;
    try {
      const next = await fetchStudyRoutineStatus();
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

  const markConfigured = useCallback(async () => {
    setStatus('configured');
    try {
      await markStudyRoutineConfigured();
    } catch {
      // Keep the optimistic 'configured' — the user did complete the step. A
      // failed write just means the server may re-serve the gate next session
      // (rare, acceptable — the config values themselves were already persisted).
    }
  }, []);

  return { status, loading, refresh, setStatus, markConfigured };
}
