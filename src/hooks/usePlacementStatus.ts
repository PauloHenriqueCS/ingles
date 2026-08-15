import { useState, useEffect, useCallback } from 'react';
import { getPlacementState, type PlacementStatus } from '../lib/placementApi';

/**
 * Server-persisted placement status (NEVER localStorage) — drives both the
 * post-signup onboarding gate and the conditional "Teste de nível" menu item.
 * `status` is null while unknown/unavailable so the app never blocks on it.
 */
export function usePlacementStatus(userId: string | undefined) {
  const [status, setStatus] = useState<PlacementStatus | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const refresh = useCallback(async () => {
    if (!userId) return;
    try {
      const state = await getPlacementState();
      setStatus(state.placementStatus);
    } catch {
      // On any failure treat placement as unknown → never block the app or the
      // onboarding gate (the user still reaches Home).
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

  return { status, loading, refresh, setStatus };
}
