import { useCallback, useEffect, useState } from 'react';
import { getCurriculumProgress, type CurriculumProgress } from '../lib/curriculumApi';

interface CurriculumFocusState {
  data: CurriculumProgress | null;
  loading: boolean;
  error: boolean;
  refetch: () => void;
}

/**
 * The user's CURRENT curriculum recorte (focus) + macro position, sourced from
 * the server-authoritative /api/curriculum/progress endpoint. Shared by the Home
 * "Foco atual" block and the Conversation mode chooser so both show the exact
 * same current focus the four curricular modalities resolve toward. Loading and
 * error resolve to a neutral, non-blocking state — the focus block simply hides
 * itself rather than inventing a recorte on a backend error.
 */
export function useCurriculumFocus(): CurriculumFocusState {
  const [data, setData] = useState<CurriculumProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(() => {
    let active = true;
    setLoading(true);
    setError(false);
    getCurriculumProgress()
      .then((p) => { if (active) { setData(p); setLoading(false); } })
      .catch(() => { if (active) { setError(true); setLoading(false); } });
    return () => { active = false; };
  }, []);

  useEffect(() => load(), [load]);

  return { data, loading, error, refetch: () => { load(); } };
}
