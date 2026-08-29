import { useRef, useState, useEffect, useCallback } from 'react';
import { applyPlaybackRate } from './audioPlaybackRate';

export type AudioPlayerState = {
  currentTimeMs: number;
  durationMs: number;
  isPlaying: boolean;
  isEnded: boolean;
  isLoading: boolean;
};

export function useListeningAudioPlayer() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const onEndedCallbackRef = useRef<(() => void) | null>(null);
  // The currently-selected playback rate, mirrored outside React state so it can
  // be re-applied to any freshly-created / re-sourced element (see setRate).
  const rateRef = useRef<number>(1);

  const [state, setState] = useState<AudioPlayerState>({
    currentTimeMs: 0,
    durationMs: 0,
    isPlaying: false,
    isEnded: false,
    isLoading: false,
  });

  const load = useCallback((url: string, knownDurationMs?: number) => {
    const prev = audioRef.current;
    if (prev) {
      prev.pause();
      prev.src = '';
    }

    const audio = new Audio(url);
    audioRef.current = audio;
    // A brand-new element starts at 1.0×; re-apply the user's selected rate so a
    // fresh load (e.g. next episode block) never silently reverts to 1.0×.
    applyPlaybackRate(audio, rateRef.current);

    setState({
      currentTimeMs: 0,
      durationMs: knownDurationMs ?? 0,
      isPlaying: false,
      isEnded: false,
      isLoading: true,
    });

    audio.addEventListener('canplay', () => {
      setState(s => ({ ...s, isLoading: false }));
    });
    // The media-load algorithm resets playbackRate to defaultPlaybackRate when a
    // resource is (re)selected. Re-assert the selected rate once metadata is in,
    // so it holds regardless of when the async reset lands.
    audio.addEventListener('loadedmetadata', () => {
      applyPlaybackRate(audio, rateRef.current);
    });
    audio.addEventListener('durationchange', () => {
      if (audio.duration && isFinite(audio.duration)) {
        setState(s => ({ ...s, durationMs: audio.duration * 1000 }));
      }
    });
    audio.addEventListener('timeupdate', () => {
      setState(s => ({ ...s, currentTimeMs: audio.currentTime * 1000 }));
    });
    audio.addEventListener('play', () => {
      setState(s => ({ ...s, isPlaying: true, isEnded: false }));
    });
    audio.addEventListener('pause', () => {
      setState(s => ({ ...s, isPlaying: false }));
    });
    audio.addEventListener('ended', () => {
      setState(s => ({ ...s, isPlaying: false, isEnded: true }));
      onEndedCallbackRef.current?.();
    });
    audio.addEventListener('error', () => {
      setState(s => ({ ...s, isLoading: false }));
    });
  }, []);

  const play = useCallback(async () => {
    if (audioRef.current) {
      try {
        await audioRef.current.play();
      } catch {
        // Autoplay blocked — caller handles this
      }
    }
  }, []);

  const pause = useCallback(() => {
    audioRef.current?.pause();
  }, []);

  const restart = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.currentTime = 0;
      setState(s => ({ ...s, currentTimeMs: 0, isEnded: false }));
    }
  }, []);

  const seekBack = useCallback((seconds: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - seconds);
    }
  }, []);

  const setRate = useCallback((rate: number) => {
    rateRef.current = rate;
    if (audioRef.current) {
      applyPlaybackRate(audioRef.current, rate);
    }
  }, []);

  // Update URL in-place without losing position (for URL refresh before expiry).
  const updateUrl = useCallback((newUrl: string) => {
    const audio = audioRef.current;
    if (!audio) return;
    const pos = audio.currentTime;
    const wasPlaying = !audio.paused && !audio.ended;
    audio.src = newUrl;
    // Re-selecting the resource resets playbackRate → re-apply the selected rate.
    applyPlaybackRate(audio, rateRef.current);
    audio.currentTime = pos;
    if (wasPlaying) audio.play().catch(() => {});
  }, []);

  const setOnEnded = useCallback((cb: () => void) => {
    onEndedCallbackRef.current = cb;
  }, []);

  useEffect(() => {
    return () => {
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        audio.src = '';
        audioRef.current = null;
      }
    };
  }, []);

  return { audioRef, state, load, play, pause, restart, seekBack, setRate, updateUrl, setOnEnded };
}
