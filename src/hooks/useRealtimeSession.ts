import { useRef, useState, useCallback, useEffect } from 'react';
import { getAuthHeader } from '../lib/apiAuth';
import {
  reportSessionActive,
  reportSessionFailed,
  reportSessionUsage,
  reportSessionEnd,
  toSessionEndReason,
} from '../lib/realtimeGatewayReporting';

export type SessionStatus = 'idle' | 'connecting' | 'active' | 'error' | 'ended';

interface SessionInfo {
  sessionId: string | null;
  voice: string;
  model: string;
}

export interface UseRealtimeSession {
  status: SessionStatus;
  errorMessage: string | null;
  errorCode: string | null;
  elapsedMs: number;
  sessionInfo: SessionInfo | null;
  isSpeaking: boolean;
  /** Accumulated transcript of the current (or last) AI response, from audio_transcript.delta events. */
  transcriptText: string;
  start: () => Promise<void>;
  end: () => void;
  updateInstructions: (instructions: string) => void;
}

const MAX_SESSION_MS = 30 * 60 * 1000;
const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';

/** Base interval (ms per character) for the paced caption reveal at 1× speed.
 *  Scaled by playbackRate: slower speed → more ms per char → captions stay in sync. */
const BASE_REVEAL_INTERVAL_MS = 140;

function stopStream(stream: MediaStream | null) {
  if (!stream) return;
  stream.getTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } });
}

function getMicErrorMessage(err: unknown): { message: string; code: string } {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') {
      return { message: 'Permissão do microfone negada.', code: 'MIC_PERMISSION_DENIED' };
    }
    if (err.name === 'NotFoundError') {
      return { message: 'Nenhum microfone foi encontrado.', code: 'MIC_NOT_FOUND' };
    }
  }
  return { message: 'Não foi possível acessar o microfone.', code: 'MIC_ERROR' };
}

/**
 * @param playbackRate - Audio playback rate (0.65 / 0.80 / 1.0).
 *   Applied to the WebRTC audio element and used to pace the caption reveal timer.
 */
export function useRealtimeSession(playbackRate: number = 1.0): UseRealtimeSession {
  const [status, setStatus] = useState<SessionStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [transcriptText, setTranscriptText] = useState('');

  const pcRef              = useRef<RTCPeerConnection | null>(null);
  const dcRef              = useRef<RTCDataChannel | null>(null);
  const streamRef          = useRef<MediaStream | null>(null);
  const timerRef           = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef       = useRef<number | null>(null);
  const endCalledRef       = useRef(false);
  const transcriptAccumRef = useRef('');
  const responseActiveRef  = useRef(false);
  const displayCountRef    = useRef(0);
  const revealTimerRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const playbackRateRef    = useRef<number>(playbackRate);
  // AI Gateway bridge (conversation.webrtc_connect / conversation.realtime_usage):
  // gatewaySessionId is only ever set when the backend is in observe mode
  // (see /api/conversation/session's additive gatewaySessionId field). While
  // legacy (always, at this stage), this stays null and none of the
  // reporting calls below ever fire — zero behavior change.
  const gatewaySessionIdRef      = useRef<string | null>(null);
  const sessionReportedActiveRef = useRef(false);

  // ── Reveal timer factory (shared by initial setup and speed-change restart) ──
  const startRevealTimer = useCallback(() => {
    if (revealTimerRef.current) clearInterval(revealTimerRef.current);
    const intervalMs = Math.round(BASE_REVEAL_INTERVAL_MS / playbackRateRef.current);
    revealTimerRef.current = setInterval(() => {
      const full = transcriptAccumRef.current;
      if (displayCountRef.current >= full.length) return;
      displayCountRef.current++;
      setTranscriptText(full.slice(0, displayCountRef.current));
    }, intervalMs);
  }, []);

  // ── Sync playback rate: update ref, audio element, and caption timer ─────────
  useEffect(() => {
    playbackRateRef.current = playbackRate;

    // Update the WebRTC audio element if it is actively streaming.
    // playbackRate on a MediaStream source is supported in modern Chromium/Firefox;
    // on unsupported browsers it silently no-ops (falls back to 1× speed).
    const audioEl = document.getElementById('realtime-audio') as HTMLAudioElement | null;
    if (audioEl && audioEl.srcObject) {
      audioEl.playbackRate = playbackRate;
    }

    // If a response is in progress, restart the reveal timer at the new rate
    // so captions stay in sync with the updated playback speed.
    if (responseActiveRef.current) {
      startRevealTimer();
    }
  }, [playbackRate, startRevealTimer]);

  const cleanup = useCallback((nextStatus?: SessionStatus, endReason?: string) => {
    endCalledRef.current = true;

    // Capture before resetting below — needed for the gateway report fired
    // at the end of this function. No duration is computed or sent here:
    // the backend derives session_seconds itself from its own
    // server-controlled timestamps (ai_provider_sessions.started_at through
    // /session/end's own clock) — a client-reported duration is never trusted.
    const gatewaySessionId = gatewaySessionIdRef.current;
    const wasActive         = sessionReportedActiveRef.current;

    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (revealTimerRef.current) { clearInterval(revealTimerRef.current); revealTimerRef.current = null; }
    if (dcRef.current) { try { dcRef.current.close(); } catch { /* ignore */ } dcRef.current = null; }
    if (pcRef.current) { try { pcRef.current.close(); } catch { /* ignore */ } pcRef.current = null; }
    stopStream(streamRef.current);
    streamRef.current = null;

    startTimeRef.current = null;
    transcriptAccumRef.current = '';
    displayCountRef.current = 0;
    responseActiveRef.current = false;
    setIsSpeaking(false);
    setSessionInfo(null);
    if (nextStatus) setStatus(nextStatus);

    // AI Gateway bridge — fire-and-forget, best-effort. Cleared immediately
    // so a second cleanup() call (React Strict Mode double-invoke, end()
    // followed by dc.onclose, etc.) is a client-side no-op even before the
    // backend's own idempotent status check would catch it.
    if (gatewaySessionId) {
      gatewaySessionIdRef.current = null;
      sessionReportedActiveRef.current = false;
      if (wasActive) {
        reportSessionEnd(gatewaySessionId);
      } else {
        reportSessionFailed(gatewaySessionId, toSessionEndReason(endReason));
      }
    }
  }, []);

  useEffect(() => () => { cleanup(undefined, 'unmounted'); }, [cleanup]);

  const fail = useCallback((code: string, message: string) => {
    cleanup(undefined, code);
    setStatus('error');
    setErrorCode(code);
    setErrorMessage(message);
  }, [cleanup]);

  const start = useCallback(async () => {
    if (status === 'connecting' || status === 'active') return;

    endCalledRef.current = false;
    setStatus('connecting');
    setErrorMessage(null);
    setErrorCode(null);
    setElapsedMs(0);

    // ── Step 1: Mic first (must be in user gesture context, especially on Safari/iPhone) ─
    if (!navigator.mediaDevices?.getUserMedia) {
      fail('MIC_NOT_SUPPORTED', 'Este navegador não oferece suporte ao microfone.');
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const { message, code } = getMicErrorMessage(err);
      fail(code, message);
      return;
    }

    if (endCalledRef.current) { stopStream(stream); return; }
    streamRef.current = stream;

    // ── Step 2: Get ephemeral token from our backend ─────────────────────────
    let token: string;
    let sessionId: string | null;
    let voice: string;
    let model: string;
    try {
      const headers = await getAuthHeader();
      const resp = await fetch('/api/conversation/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
      });

      if (!resp.ok) {
        const json = await resp.json().catch(() => ({})) as { code?: string; message?: string };
        fail(json.code ?? 'SESSION_ERROR', json.message ?? 'Falha ao iniciar sessão.');
        stopStream(stream);
        streamRef.current = null;
        return;
      }

      const body = await resp.json() as {
        token: string; sessionId: string | null; voice: string; model: string;
        gatewaySessionId?: string;
      };
      token     = body.token;
      sessionId = body.sessionId;
      voice     = body.voice;
      model     = body.model;
      // Additive/optional — only present when conversation.webrtc_connect is
      // in observe mode. Absent (legacy, always at this stage) means every
      // gateway report below stays a no-op.
      gatewaySessionIdRef.current = typeof body.gatewaySessionId === 'string' ? body.gatewaySessionId : null;
    } catch {
      fail('NETWORK_ERROR', 'Erro de rede ao iniciar a sessão.');
      stopStream(stream);
      streamRef.current = null;
      return;
    }

    if (endCalledRef.current) { stopStream(stream); streamRef.current = null; return; }

    setSessionInfo({ sessionId, voice, model });

    // ── Step 3: RTCPeerConnection ─────────────────────────────────────────────
    const pc = new RTCPeerConnection();
    pcRef.current = pc;

    stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));

    pc.ontrack = (e) => {
      const audioEl = document.getElementById('realtime-audio') as HTMLAudioElement | null;
      if (audioEl) {
        audioEl.srcObject = e.streams[0];
        // Apply the current playback rate immediately when the track arrives.
        audioEl.playbackRate = playbackRateRef.current;
        audioEl.play().catch(() => undefined);
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (
        pc.iceConnectionState === 'failed' ||
        pc.iceConnectionState === 'disconnected'
      ) {
        if (!endCalledRef.current) {
          fail('CONNECTION_LOST', 'Conexão perdida. Tente novamente.');
        }
      }
    };

    // ── Step 4: Data channel ─────────────────────────────────────────────────
    const dc = pc.createDataChannel('oai-events');
    dcRef.current = dc;

    dc.onopen = () => {
      if (endCalledRef.current) return;
      setStatus('active');
      startTimeRef.current = Date.now();
      timerRef.current = setInterval(() => {
        const elapsed = Date.now() - (startTimeRef.current ?? Date.now());
        setElapsedMs(elapsed);
        if (elapsed >= MAX_SESSION_MS) cleanup('ended', 'max_duration_reached');
      }, 1000);
      // AI Gateway bridge: the physical WebRTC connection is now confirmed
      // live — report it (no-op if gatewaySessionId is absent, i.e. legacy).
      if (gatewaySessionIdRef.current) {
        sessionReportedActiveRef.current = true;
        reportSessionActive(gatewaySessionIdRef.current);
      }
      // Trigger AI greeting immediately — it reads context from system prompt
      setTimeout(() => {
        if (!endCalledRef.current && dcRef.current?.readyState === 'open') {
          dcRef.current.send(JSON.stringify({ type: 'response.create' }));
        }
      }, 600);
    };

    dc.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data as string) as {
          type: string;
          delta?: string;
          transcript?: string;
          error?: { type?: string; code?: string; param?: string };
          response?: { id?: string; usage?: Record<string, unknown> };
        };

        // Reset transcript and start paced reveal on new response
        if (ev.type === 'response.created') {
          responseActiveRef.current = true;
          transcriptAccumRef.current = '';
          displayCountRef.current = 0;
          setTranscriptText('');
          // Start reveal timer scaled to current playback rate.
          // Slower speed → larger interval → captions advance in sync with audio.
          startRevealTimer();
        }

        if (ev.type === 'response.output_audio.delta') {
          setIsSpeaking(true);
        }

        // Accumulate transcript deltas into ref only — reveal timer controls display
        const isTranscriptDelta =
          ev.type === 'response.audio_transcript.delta' ||
          ev.type === 'response.output_audio_transcript.delta';
        if (isTranscriptDelta && typeof ev.delta === 'string') {
          transcriptAccumRef.current += ev.delta;
        }

        if (ev.type === 'response.done') {
          responseActiveRef.current = false;
          setIsSpeaking(false);
          // Stop reveal timer and snap to full text so nothing is cut off
          if (revealTimerRef.current) { clearInterval(revealTimerRef.current); revealTimerRef.current = null; }
          setTranscriptText(transcriptAccumRef.current);

          // AI Gateway bridge: relay the official per-response usage object
          // verbatim (numeric counters only) — no-op if gatewaySessionId is
          // absent (legacy) or this particular response carries no usage.
          if (gatewaySessionIdRef.current && ev.response?.id && ev.response?.usage) {
            reportSessionUsage(gatewaySessionIdRef.current, ev.response.id, ev.response.usage);
          }
        }

        // Error events from the server
        if (ev.type === 'error') {
          const err = ev.error ?? {};
          console.error('[realtime] server error event', {
            type: err.type ?? null,
            code: err.code ?? null,
            param: err.param ?? null,
          });
          if (!endCalledRef.current) {
            fail('SESSION_ERROR', 'Ocorreu um erro na sessão. Tente novamente.');
          }
        }
      } catch { /* ignore parse errors */ }
    };

    dc.onclose = () => {
      if (!endCalledRef.current) cleanup('ended', 'dc_closed');
    };

    // ── Step 5: SDP offer → /v1/realtime/calls ───────────────────────────────
    let offer: RTCSessionDescriptionInit;
    try {
      offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
    } catch {
      fail('WEBRTC_FAILED', 'Não foi possível iniciar a negociação WebRTC.');
      return;
    }

    if (!offer.sdp) {
      fail('WEBRTC_FAILED', 'O SDP da oferta está vazio.');
      return;
    }

    if (endCalledRef.current) return;

    let answerSdp: string;
    try {
      const sdpResp = await fetch(REALTIME_CALLS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/sdp',
        },
        body: offer.sdp,
      });

      if (!sdpResp.ok) {
        const errText = await sdpResp.text().catch(() => '');
        console.error('[realtime] /calls failed', { status: sdpResp.status, body: errText.slice(0, 200) });
        fail('WEBRTC_FAILED', 'Falha na conexão com o serviço de IA. Tente novamente.');
        return;
      }

      answerSdp = await sdpResp.text();
    } catch {
      fail('WEBRTC_NETWORK', 'Erro de rede ao conectar ao serviço de IA.');
      return;
    }

    if (!answerSdp) {
      fail('WEBRTC_FAILED', 'Resposta SDP vazia recebida do serviço de IA.');
      return;
    }

    if (endCalledRef.current) return;

    try {
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    } catch {
      fail('WEBRTC_FAILED', 'Não foi possível estabelecer a conexão WebRTC.');
    }
  }, [status, cleanup, fail, startRevealTimer]);

  const end = useCallback(() => {
    cleanup('ended', 'user_ended');
  }, [cleanup]);

  const updateInstructions = useCallback((instructions: string) => {
    if (!dcRef.current || dcRef.current.readyState !== 'open') return;
    dcRef.current.send(JSON.stringify({
      type: 'session.update',
      session: { type: 'realtime', instructions },
    }));
  }, []);

  return {
    status, errorMessage, errorCode, elapsedMs, sessionInfo, isSpeaking,
    transcriptText,
    start, end, updateInstructions,
  };
}
