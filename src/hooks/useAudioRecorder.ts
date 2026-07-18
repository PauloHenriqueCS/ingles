import { useState, useRef, useEffect, useCallback } from 'react';

export type RecorderPhase = 'idle' | 'requesting' | 'recording' | 'done' | 'error';

export interface UseAudioRecorderReturn {
  phase: RecorderPhase;
  elapsedMs: number;
  audioBlob: Blob | null;
  audioUrl: string | null;
  durationMs: number;
  errorMessage: string | null;
  /** True when this recording was auto-stopped by maxDurationMs, not by the user. */
  stoppedByMaxDuration: boolean;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
  deleteRecording: () => void;
}

function detectMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

function classifyError(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'O acesso ao microfone foi negado. No iPhone, abra Ajustes > Chrome > Microfone, autorize o acesso e tente novamente.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'NotReadableError' || name === 'TrackStartError') {
    return 'Não foi possível encontrar ou acessar um microfone disponível.';
  }
  if (name === 'NotSupportedError') {
    return 'Este navegador não oferece suporte à gravação de áudio. Tente usar uma versão atualizada do Chrome ou Safari.';
  }
  return 'Não foi possível criar a gravação. Verifique o microfone e tente novamente.';
}

/**
 * @param maxDurationMs Optional hard cap (e.g. the plan's recording-duration
 * limit). When set, the recording auto-stops the instant it's reached —
 * never a technical concern, purely a commercial limit passed in by the caller.
 */
export function useAudioRecorder(maxDurationMs?: number): UseAudioRecorderReturn {
  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [stoppedByMaxDuration, setStoppedByMaxDuration] = useState(false);
  const maxDurationRef = useRef<number | undefined>(maxDurationMs);
  maxDurationRef.current = maxDurationMs;

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const currentUrlRef = useRef<string | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (mediaRecorderRef.current?.state !== 'inactive') {
        try { mediaRecorderRef.current?.stop(); } catch { /* ignore */ }
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (currentUrlRef.current) URL.revokeObjectURL(currentUrlRef.current);
    };
  }, []);

  function stopMicAndTimer() {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  const startRecording = useCallback(async () => {
    if (!isMountedRef.current) return;

    if (!navigator.mediaDevices?.getUserMedia) {
      setErrorMessage('Este navegador não oferece suporte à gravação de áudio. Tente usar uma versão atualizada do Chrome ou Safari.');
      setPhase('error');
      return;
    }

    // Revoke any previous blob URL
    if (currentUrlRef.current) {
      URL.revokeObjectURL(currentUrlRef.current);
      currentUrlRef.current = null;
    }

    // Stop any ongoing recording before starting a new one
    if (mediaRecorderRef.current?.state !== 'inactive') {
      try { mediaRecorderRef.current?.stop(); } catch { /* ignore */ }
    }
    stopMicAndTimer();

    chunksRef.current = [];
    setAudioBlob(null);
    setAudioUrl(null);
    setDurationMs(0);
    setElapsedMs(0);
    setErrorMessage(null);
    setStoppedByMaxDuration(false);
    setPhase('requesting');

    // Request microphone immediately — must happen directly in the user gesture on iOS
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      if (!isMountedRef.current) return;
      setErrorMessage(classifyError(err));
      setPhase('error');
      return;
    }

    if (!isMountedRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    // After receiving the stream, verify MediaRecorder is available
    if (typeof MediaRecorder === 'undefined') {
      stream.getTracks().forEach((t) => t.stop());
      setErrorMessage('Este navegador não oferece suporte à gravação de áudio. Tente usar uma versão atualizada do Chrome ou Safari.');
      setPhase('error');
      return;
    }

    streamRef.current = stream;
    const mimeType = detectMimeType();

    let recorder: MediaRecorder;
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      if (!isMountedRef.current) return;
      setErrorMessage(classifyError(err));
      setPhase('error');
      return;
    }

    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onstop = () => {
      stopMicAndTimer();
      if (!isMountedRef.current) return;

      const elapsed = Date.now() - startTimeRef.current;
      const chunks = chunksRef.current;

      if (chunks.length === 0) {
        setErrorMessage('Não foi possível criar a gravação. Verifique o microfone e tente novamente.');
        setPhase('error');
        return;
      }

      const blob = new Blob(chunks, { type: mimeType || recorder.mimeType || 'audio/mp4' });
      const url = URL.createObjectURL(blob);
      currentUrlRef.current = url;

      setAudioBlob(blob);
      setAudioUrl(url);
      setDurationMs(elapsed);
      setPhase('done');
    };

    recorder.onerror = () => {
      stopMicAndTimer();
      if (!isMountedRef.current) return;
      setErrorMessage('Esta gravação foi interrompida. Grave novamente.');
      setPhase('error');
    };

    try {
      recorder.start(250);
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      if (!isMountedRef.current) return;
      setErrorMessage(classifyError(err));
      setPhase('error');
      return;
    }

    startTimeRef.current = Date.now();
    setPhase('recording');

    intervalRef.current = setInterval(() => {
      if (!isMountedRef.current) return;
      const elapsed = Date.now() - startTimeRef.current;
      setElapsedMs(elapsed);
      const max = maxDurationRef.current;
      if (max && elapsed >= max && mediaRecorderRef.current?.state === 'recording') {
        setStoppedByMaxDuration(true);
        mediaRecorderRef.current.stop();
      }
    }, 200);
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const deleteRecording = useCallback(() => {
    if (currentUrlRef.current) {
      URL.revokeObjectURL(currentUrlRef.current);
      currentUrlRef.current = null;
    }
    setAudioBlob(null);
    setAudioUrl(null);
    setDurationMs(0);
    setElapsedMs(0);
    setErrorMessage(null);
    setStoppedByMaxDuration(false);
    setPhase('idle');
  }, []);

  return { phase, elapsedMs, audioBlob, audioUrl, durationMs, errorMessage, stoppedByMaxDuration, startRecording, stopRecording, deleteRecording };
}
