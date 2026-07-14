import { useRef, useState, useCallback, useEffect } from 'react';
import { getAuthHeader } from '../lib/apiAuth';

export type SessionStatus = 'idle' | 'connecting' | 'active' | 'error' | 'ended';

interface SessionInfo {
  sessionId: string;
  voice: string;
}

export interface UseRealtimeSession {
  status: SessionStatus;
  errorMessage: string | null;
  elapsedMs: number;
  sessionInfo: SessionInfo | null;
  isSpeaking: boolean;
  start: () => Promise<void>;
  end: () => void;
  updateInstructions: (instructions: string) => void;
}

const MAX_SESSION_MS = 30 * 60 * 1000;
const REALTIME_MODEL = 'gpt-realtime-2.1-mini';

export function useRealtimeSession(): UseRealtimeSession {
  const [status, setStatus] = useState<SessionStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const pcRef    = useRef<RTCPeerConnection | null>(null);
  const dcRef    = useRef<RTCDataChannel | null>(null);
  const streamRef    = useRef<MediaStream | null>(null);
  const timerRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const endCalledRef = useRef(false);

  const cleanup = useCallback((nextStatus?: SessionStatus) => {
    endCalledRef.current = true;

    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }

    if (dcRef.current) { try { dcRef.current.close(); } catch { /* ignore */ } dcRef.current = null; }
    if (pcRef.current) { try { pcRef.current.close(); } catch { /* ignore */ } pcRef.current = null; }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } });
      streamRef.current = null;
    }

    startTimeRef.current = null;
    setIsSpeaking(false);
    setSessionInfo(null);
    if (nextStatus) setStatus(nextStatus);
  }, []);

  useEffect(() => () => { cleanup(); }, [cleanup]);

  const start = useCallback(async () => {
    if (status === 'connecting' || status === 'active') return;

    endCalledRef.current = false;
    setStatus('connecting');
    setErrorMessage(null);
    setElapsedMs(0);

    try {
      // 1. Get ephemeral token from our backend
      const headers = await getAuthHeader();
      const resp = await fetch('/api/conversation/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
      });

      if (!resp.ok) {
        const json = await resp.json().catch(() => ({}));
        throw new Error(json.message ?? 'Falha ao iniciar sessão');
      }

      const { token, sessionId, voice } = await resp.json() as {
        token: string; sessionId: string; voice: string;
      };

      if (endCalledRef.current) return;

      setSessionInfo({ sessionId, voice });

      // 2. Get mic stream
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (endCalledRef.current) { stream.getTracks().forEach((t) => t.stop()); return; }
      streamRef.current = stream;

      // 3. Create RTCPeerConnection
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      // 4. Add mic audio track
      stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));

      // 5. Route remote audio to hidden <audio> element
      pc.ontrack = (e) => {
        const audioEl = document.getElementById('realtime-audio') as HTMLAudioElement | null;
        if (audioEl) {
          audioEl.srcObject = e.streams[0];
          audioEl.play().catch(() => undefined);
        }
      };

      // 6. Create data channel for events
      const dc = pc.createDataChannel('oai-events');
      dcRef.current = dc;

      dc.onopen = () => {
        if (endCalledRef.current) return;
        setStatus('active');
        startTimeRef.current = Date.now();
        timerRef.current = setInterval(() => {
          const elapsed = Date.now() - (startTimeRef.current ?? Date.now());
          setElapsedMs(elapsed);
          if (elapsed >= MAX_SESSION_MS) cleanup('ended');
        }, 1000);
      };

      dc.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data as string) as { type: string };
          if (ev.type === 'output_audio_buffer.started') setIsSpeaking(true);
          if (
            ev.type === 'output_audio_buffer.stopped' ||
            ev.type === 'output_audio_buffer.committed'
          ) setIsSpeaking(false);
        } catch { /* ignore */ }
      };

      dc.onclose = () => {
        if (!endCalledRef.current) cleanup('ended');
      };

      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
          cleanup('error');
          setErrorMessage('Conexão perdida. Tente novamente.');
        }
      };

      // 7. Create SDP offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      if (endCalledRef.current) return;

      // 8. Send offer to OpenAI Realtime
      const sdpResp = await fetch(
        `https://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/sdp' },
          body: offer.sdp,
        },
      );

      if (!sdpResp.ok) throw new Error('Falha ao conectar ao serviço de IA');

      const answerSdp = await sdpResp.text();
      if (endCalledRef.current) return;

      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

    } catch (err) {
      cleanup();
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : 'Erro ao iniciar conversa');
    }
  }, [status, cleanup]);

  const end = useCallback(() => {
    cleanup('ended');
  }, [cleanup]);

  const updateInstructions = useCallback((instructions: string) => {
    if (!dcRef.current || dcRef.current.readyState !== 'open') return;
    dcRef.current.send(JSON.stringify({ type: 'session.update', session: { instructions } }));
  }, []);

  return { status, errorMessage, elapsedMs, sessionInfo, isSpeaking, start, end, updateInstructions };
}
