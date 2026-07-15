/**
 * V2AudioPlayer — "Ouvir texto" button for Version 2.
 *
 * - Fetches audio from /api/tts on first click, caches the Blob URL in memory.
 * - Reuseuses the same audio on pause / continue / replay — no extra Azure calls.
 * - Invalidates cache when the `text` prop changes.
 * - Cleans up Blob URL and audio element on unmount.
 * - Prevents duplicate in-flight requests via AbortController + loading guard.
 */

import { useState, useRef, useEffect } from 'react';
import { Volume2, Loader2, Play, Pause, RotateCcw, AlertCircle } from 'lucide-react';
import { getAuthHeader } from '../lib/apiAuth';
import { fetchAudioSettings, DEFAULT_AUDIO_SETTINGS, AudioSettings } from '../lib/audioSettings';

type AudioState = 'idle' | 'loading' | 'playing' | 'paused' | 'done' | 'error';
type Speed = 0.75 | 0.9 | 1;

const SPEEDS: Speed[] = [0.75, 0.9, 1];

interface Props {
  text: string;
}

export default function V2AudioPlayer({ text }: Props) {
  const [audioState, setAudioState] = useState<AudioState>('idle');
  const [speed, setSpeed] = useState<Speed>(1);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const prevTextRef = useRef(text);
  const audioSettingsRef = useRef<AudioSettings>(DEFAULT_AUDIO_SETTINGS);

  // Track mounting + load audio settings
  useEffect(() => {
    mountedRef.current = true;
    fetchAudioSettings().then((s) => {
      audioSettingsRef.current = s;
      if (mountedRef.current) setSpeed(s.playbackRate);
    }).catch(() => {});
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      stopAndCleanAudio();
      revokeBlobUrl();
    };
  }, []);

  // Invalidate when text changes
  useEffect(() => {
    if (prevTextRef.current === text) return;
    prevTextRef.current = text;
    abortRef.current?.abort();
    stopAndCleanAudio();
    revokeBlobUrl();
    if (mountedRef.current) setAudioState('idle');
  }, [text]);

  function stopAndCleanAudio() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current = null;
    }
  }

  function revokeBlobUrl() {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  }

  async function getBlobUrl(): Promise<string> {
    // Return cached URL if text matches
    if (blobUrlRef.current) return blobUrlRef.current;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const authHeader = await getAuthHeader();

    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify({ text, voice: audioSettingsRef.current.voice }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message ?? 'Erro ao gerar áudio');
    }

    const blob = await res.blob();
    if (!blob.size) throw new Error('Resposta sem áudio');

    const url = URL.createObjectURL(blob);
    blobUrlRef.current = url;
    return url;
  }

  function attachAudio(url: string): HTMLAudioElement {
    const audio = new Audio(url);
    audio.playbackRate = speed;
    audio.onended = () => { if (mountedRef.current) setAudioState('done'); };
    audio.onerror = () => { if (mountedRef.current) setAudioState('error'); };
    audioRef.current = audio;
    return audio;
  }

  async function handleMainClick() {
    if (audioState === 'loading') return;

    // Resume paused audio
    if (audioState === 'paused' && audioRef.current) {
      try {
        await audioRef.current.play();
        if (mountedRef.current) setAudioState('playing');
      } catch {
        if (mountedRef.current) setAudioState('error');
      }
      return;
    }

    // Restart from 'done' state (no new fetch)
    if (audioState === 'done' && audioRef.current && blobUrlRef.current) {
      audioRef.current.currentTime = 0;
      try {
        await audioRef.current.play();
        if (mountedRef.current) setAudioState('playing');
      } catch {
        if (mountedRef.current) setAudioState('error');
      }
      return;
    }

    // First play or retry after error
    setAudioState('loading');
    try {
      const url = await getBlobUrl();
      if (!mountedRef.current) return;

      const audio = attachAudio(url);
      await audio.play();
      if (mountedRef.current) setAudioState('playing');
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof Error && err.name === 'AbortError') return;
      setAudioState('error');
    }
  }

  function handlePause() {
    audioRef.current?.pause();
    if (mountedRef.current) setAudioState('paused');
  }

  function handleRestart() {
    if (!audioRef.current || !blobUrlRef.current) {
      // No cached audio — full re-fetch
      stopAndCleanAudio();
      setAudioState('idle');
      return;
    }
    audioRef.current.currentTime = 0;
    audioRef.current.play()
      .then(() => { if (mountedRef.current) setAudioState('playing'); })
      .catch(() => { if (mountedRef.current) setAudioState('error'); });
  }

  function handleSpeedChange(s: Speed) {
    setSpeed(s);
    if (audioRef.current) audioRef.current.playbackRate = s;
  }

  const isLoading = audioState === 'loading';
  const isPlaying = audioState === 'playing';
  const isPaused = audioState === 'paused';
  const isDone = audioState === 'done';
  const isError = audioState === 'error';
  const isActive = isPlaying || isPaused || isDone;

  if (isError) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <AlertCircle className="w-4 h-4 text-red-400 shrink-0" aria-hidden="true" />
        <span className="text-xs text-red-400">Não foi possível gerar o áudio agora. Tente novamente.</span>
        <button
          onClick={() => setAudioState('idle')}
          className="text-xs text-slate-400 hover:text-slate-200 underline transition-colors"
        >
          Tentar novamente
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Main play/pause/resume button */}
      <button
        onClick={isPlaying ? handlePause : handleMainClick}
        disabled={isLoading}
        aria-label={
          isLoading ? 'Carregando áudio da Versão 2'
          : isPlaying ? 'Pausar áudio da Versão 2'
          : isPaused ? 'Continuar áudio da Versão 2'
          : isDone ? 'Ouvir novamente a Versão 2'
          : 'Ouvir a pronúncia da Versão 2'
        }
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors
          focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 focus:ring-offset-slate-900
          disabled:opacity-50 disabled:cursor-not-allowed min-h-[32px]
          ${isPlaying || isPaused
            ? 'bg-purple-700 hover:bg-purple-600 text-white'
            : 'bg-slate-700 hover:bg-slate-600 text-slate-200'
          }`}
      >
        {isLoading && (
          <>
            <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" aria-hidden="true" />
            <span>Carregando áudio...</span>
          </>
        )}
        {!isLoading && isPlaying && (
          <>
            <Pause className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>Pausar</span>
          </>
        )}
        {!isLoading && isPaused && (
          <>
            <Play className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>Continuar</span>
          </>
        )}
        {!isLoading && !isPlaying && !isPaused && isDone && (
          <>
            <Volume2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>Ouvir novamente</span>
          </>
        )}
        {!isLoading && !isPlaying && !isPaused && !isDone && (
          <>
            <Volume2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>Ouvir texto</span>
          </>
        )}
      </button>

      {/* Restart button — only when audio was fetched */}
      {isActive && (
        <button
          onClick={handleRestart}
          aria-label="Reiniciar áudio do início"
          title="Reiniciar do início"
          className="p-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-400 hover:text-slate-200
            transition-colors focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2
            focus:ring-offset-slate-900 min-h-[32px] min-w-[32px] flex items-center justify-center"
        >
          <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      )}

      {/* Speed selector */}
      <div className="flex gap-1" role="group" aria-label="Velocidade de reprodução">
        {SPEEDS.map(s => (
          <button
            key={s}
            onClick={() => handleSpeedChange(s)}
            aria-label={`Velocidade ${s}x`}
            aria-pressed={speed === s}
            className={`px-2 py-1 rounded text-xs font-medium transition-colors min-h-[28px]
              focus:outline-none focus:ring-1 focus:ring-purple-500
              ${speed === s
                ? 'bg-purple-600 text-white'
                : 'bg-slate-700 text-slate-500 hover:bg-slate-600 hover:text-slate-300'
              }`}
          >
            {s}×
          </button>
        ))}
      </div>
    </div>
  );
}
