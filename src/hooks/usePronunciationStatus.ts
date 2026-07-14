import { useState, useEffect } from 'react';
import { fetchPronunciationStatus } from '../lib/pronunciationStatusFetcher';
import type { PronunciationStatusResponse } from '../types';

export interface PronunciationStatusState {
  isLoading: boolean;
  data: PronunciationStatusResponse | null;
  error: string | null;
}

export function usePronunciationStatus(reviewId: string | null): PronunciationStatusState {
  const [state, setState] = useState<PronunciationStatusState>({
    isLoading: reviewId !== null,
    data: null,
    error: null,
  });

  useEffect(() => {
    if (!reviewId) {
      setState({ isLoading: false, data: null, error: null });
      return;
    }

    setState({ isLoading: true, data: null, error: null });
    const controller = new AbortController();

    fetchPronunciationStatus(reviewId, controller.signal)
      .then((data) => {
        setState({ isLoading: false, data, error: null });
      })
      .catch((err: Error) => {
        if (err.name === 'AbortError') return;
        setState({ isLoading: false, data: null, error: err.message });
      });

    return () => controller.abort();
  }, [reviewId]);

  return state;
}
