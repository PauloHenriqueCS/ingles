import { useRef, useState, useCallback, useEffect } from 'react';
import { getAuthHeader } from '../lib/apiAuth';
import { apiUrl } from '../lib/apiUrl';
import {
  reportSessionActive,
  reportSessionFailed,
  reportSessionUsage,
  reportSessionEnd,
  toSessionEndReason,
  checkSessionControl,
  type RecordingLimitReason,
} from '../lib/realtimeGatewayReporting';
import { shouldAutoStopForCommercialLimit, pickStopMessage, pickStopEndReason, scheduleGracefulFinish } from './realtimeAutoStop';
import { getMicPermissionDeniedMessage } from '../lib/micPermissionGuidance';

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
  /**
   * Fase 12 — server-authoritative authorized recording ceiling for this
   * call, reconciled on every session-control poll. null until the first
   * /session response arrives (older cached bundles that omit the field
   * also leave this null forever — the UI simply shows elapsed-only, same
   * as before this feature).
   */
  authorizedMaxSeconds: number | null;
  /** Which constraint currently governs authorizedMaxSeconds — 'technical' must never be shown to the user as a commercial limit. */
  recordingLimitReason: RecordingLimitReason | null;
  /** Friendly message shown when the session was auto-stopped by a commercial limit (not a technical error). */
  stopMessage: string | null;
  /**
   * Server-issued id for this call's conversation_session_authorizations row
   * (see api/conversation/[...slug].ts's handleSession). Present once
   * connecting has completed a /session round-trip; persists through
   * 'ended' (not cleared by cleanup()) so the caller can pass it to
   * completeConversationSession() once, after the call ends. null when
   * absent (older cached bundle, or the backend's best-effort insert
   * failed) — the caller simply has nothing to complete in that case.
   */
  recordingAuthorizationId: string | null;
  start: () => Promise<void>;
  end: () => void;
  updateInstructions: (instructions: string) => void;
}

// Fallback only — used when the backend response omits maxSessionSeconds
// (older cached bundle mismatch, or the field failing to parse). The
// server-provided value (see Step 2 below) is authoritative when present;
// this constant matches its default so behavior is unchanged either way.
const DEFAULT_MAX_SESSION_MS = 30 * 60 * 1000;

// How often to poll /api/conversation/session-control while a session is
// active and the gateway bridge is live (never in legacy mode — see
// gatewaySessionIdRef below). Fase 9's ceiling is "≤ every 5s". This same
// poll also renews the server-side heartbeat/lease (see
// api/conversation/[...slug].ts's handleSessionControl) that the sweep job
// uses to detect an abandoned session.
const SESSION_CONTROL_POLL_MS = 5000;

// Etapa 11 — unified interface. Step 5 below POSTs the SDP offer to this
// backend endpoint instead of straight to OpenAI: the backend makes that
// call itself (server-to-server, real reliable read of the Location
// response header) and captures/persists call_id atomically, removing the
// old dependency on this browser being able to read that header via CORS
// (never verified live, and no longer needed at all).
const WEBRTC_CONNECT_URL = '/api/conversation/webrtc-connect';

/** Base interval (ms per character) for the paced caption reveal at 1× speed.
 *  Scaled by playbackRate: slower speed → more ms per char → captions stay in sync. */
const BASE_REVEAL_INTERVAL_MS = 140;

function stopStream(stream: MediaStream | null) {
  if (!stream) return;
  stream.getTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } });
}

export function getMicErrorMessage(err: unknown): { message: string; code: string } {
  // Dev-safe diagnostic only: the DOMException name/message describes the
  // capture failure itself (e.g. "NotReadableError: Could not start audio
  // source"), never audio content, session, or credentials — never shown to
  // the user (see the generic fallback message below).
  if (err instanceof DOMException) {
    console.error('[mic] getUserMedia failed', { name: err.name, message: err.message });
  } else {
    console.error('[mic] getUserMedia failed with a non-DOMException error', err);
  }

  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') {
      return { message: getMicPermissionDeniedMessage(), code: 'MIC_PERMISSION_DENIED' };
    }
    if (err.name === 'NotFoundError') {
      return { message: 'Nenhum microfone foi encontrado.', code: 'MIC_NOT_FOUND' };
    }
    if (err.name === 'NotReadableError') {
      return { message: 'O microfone está sendo usado por outro app ou não pôde ser iniciado. Feche outros apps que usem o microfone e tente novamente.', code: 'MIC_NOT_READABLE' };
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
  const [authorizedMaxSeconds, setAuthorizedMaxSeconds] = useState<number | null>(null);
  const [recordingLimitReason, setRecordingLimitReason] = useState<RecordingLimitReason | null>(null);
  const [stopMessage, setStopMessage] = useState<string | null>(null);
  const [recordingAuthorizationId, setRecordingAuthorizationId] = useState<string | null>(null);

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
  // Fase 9 — server-authoritative session ceiling + mid-session control poll.
  const maxSessionMsRef          = useRef<number>(DEFAULT_MAX_SESSION_MS);
  const sessionControlTimerRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  // Fase 12 — commercial-aware authorized recording ceiling, reconciled from
  // /session and every session-control poll. null means "unknown yet" —
  // the auto-stop check below is skipped until a real value arrives.
  const authorizedMaxSecondsRef  = useRef<number | null>(null);
  const recordingLimitReasonRef  = useRef<RecordingLimitReason | null>(null);
  const limitStopTriggeredRef    = useRef(false);

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
    if (sessionControlTimerRef.current) { clearInterval(sessionControlTimerRef.current); sessionControlTimerRef.current = null; }
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

  // Fase 12 — auto-stop when the authorized recording ceiling is reached.
  // Never abruptly kills the WebRTC connection: it stops CAPTURING new
  // audio immediately (so nothing further is ever submitted), but if the AI
  // is mid-response it lets that response finish playing before the
  // conversation actually closes — the student never hears a reply get cut
  // off mid-sentence. 'technical' never produces a message: the gateway
  // ceiling is a pure backstop, never presented as a commercial feature.
  const triggerLimitStop = useCallback((limitReason: 'per_turn' | 'monthly_balance', elapsedSeconds: number) => {
    if (limitStopTriggeredRef.current || endCalledRef.current) return;
    limitStopTriggeredRef.current = true;

    if (streamRef.current) {
      streamRef.current.getAudioTracks().forEach((t) => { t.enabled = false; });
    }

    setStopMessage(pickStopMessage(limitReason, elapsedSeconds));

    const endReason = pickStopEndReason(limitReason);
    scheduleGracefulFinish(
      () => responseActiveRef.current,
      () => { if (!endCalledRef.current) cleanup('ended', endReason); },
    );
  }, [cleanup]);

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
    limitStopTriggeredRef.current = false;
    authorizedMaxSecondsRef.current = null;
    recordingLimitReasonRef.current = null;
    setAuthorizedMaxSeconds(null);
    setRecordingLimitReason(null);
    setStopMessage(null);
    setRecordingAuthorizationId(null);

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
      const resp = await fetch(apiUrl('/api/conversation/session'), {
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
        gatewaySessionId?: string; maxSessionSeconds?: unknown;
        authorizedMaxRecordingSeconds?: unknown; recordingLimitReason?: unknown;
        recordingAuthorizationId?: unknown;
      };
      token     = body.token;
      sessionId = body.sessionId;
      voice     = body.voice;
      model     = body.model;
      // Quota-bypass fix (2026-07-21 audit) — closes the loop with
      // completeConversationSession() once this call ends. Absent whenever
      // the backend's best-effort insert didn't happen (see handleSession);
      // this call's time simply won't be credited toward monthlyTime that time.
      if (typeof body.recordingAuthorizationId === 'string' && body.recordingAuthorizationId) {
        setRecordingAuthorizationId(body.recordingAuthorizationId);
      }
      // Additive/optional — only present when conversation.webrtc_connect is
      // in observe mode. Absent (legacy, always at this stage) means every
      // gateway report below stays a no-op.
      gatewaySessionIdRef.current = typeof body.gatewaySessionId === 'string' ? body.gatewaySessionId : null;
      // Server-authoritative session ceiling (Fase 9) — falls back to the
      // module default if absent/malformed, never blocking session start.
      maxSessionMsRef.current = typeof body.maxSessionSeconds === 'number' && body.maxSessionSeconds > 0
        ? body.maxSessionSeconds * 1000
        : DEFAULT_MAX_SESSION_MS;
      // Fase 12 — commercial-aware authorized recording ceiling. Absent
      // (older cached bundle mismatch) simply leaves auto-stop disabled;
      // the pure technical ceiling above still applies either way.
      if (typeof body.authorizedMaxRecordingSeconds === 'number' && Number.isFinite(body.authorizedMaxRecordingSeconds)) {
        authorizedMaxSecondsRef.current = body.authorizedMaxRecordingSeconds;
        setAuthorizedMaxSeconds(body.authorizedMaxRecordingSeconds);
      }
      if (body.recordingLimitReason === 'per_turn' || body.recordingLimitReason === 'monthly_balance' || body.recordingLimitReason === 'technical') {
        recordingLimitReasonRef.current = body.recordingLimitReason;
        setRecordingLimitReason(body.recordingLimitReason);
      }
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

        // Fase 12 — proactive client-side auto-stop at the commercial
        // ceiling, instead of waiting for the next (up to 5s later) poll.
        const reason = recordingLimitReasonRef.current;
        if (shouldAutoStopForCommercialLimit(elapsed, authorizedMaxSecondsRef.current, reason)) {
          triggerLimitStop(reason as 'per_turn' | 'monthly_balance', elapsed / 1000);
          return;
        }

        if (elapsed >= maxSessionMsRef.current) cleanup('ended', 'max_duration_reached');
      }, 1000);
      // AI Gateway bridge: the physical WebRTC connection is now confirmed
      // live — report it (no-op if gatewaySessionId is absent, i.e. legacy).
      if (gatewaySessionIdRef.current) {
        sessionReportedActiveRef.current = true;
        reportSessionActive(gatewaySessionIdRef.current);

        // Fase 9 — best-effort mid-session control poll. Only runs while the
        // gateway bridge is live (never in legacy mode); a failure or
        // "don't terminate" response is a no-op (see checkSessionControl's
        // own fail-open contract).
        const polledGatewaySessionId = gatewaySessionIdRef.current;
        sessionControlTimerRef.current = setInterval(() => {
          if (endCalledRef.current) return;
          void checkSessionControl(polledGatewaySessionId).then((result) => {
            // Fase 12 — reconcile the authorized ceiling with the server on
            // every poll (balance may have changed since session start).
            // Never optimistic: this only ever reflects what the server
            // just returned, never a locally-guessed decrement.
            if (typeof result.authorizedMaxRecordingSeconds === 'number') {
              authorizedMaxSecondsRef.current = result.authorizedMaxRecordingSeconds;
              setAuthorizedMaxSeconds(result.authorizedMaxRecordingSeconds);
            }
            if (result.recordingLimitReason) {
              recordingLimitReasonRef.current = result.recordingLimitReason;
              setRecordingLimitReason(result.recordingLimitReason);
            }
            if (result.terminate && !endCalledRef.current) {
              cleanup('ended', result.reason ?? 'server_terminated');
            }
          });
        }, SESSION_CONTROL_POLL_MS);
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

    // ── Step 5: SDP offer → /api/conversation/webrtc-connect (unified interface) ─
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
      const headers = await getAuthHeader();
      const sdpResp = await fetch(apiUrl(WEBRTC_CONNECT_URL), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
          sdp: offer.sdp,
          ephemeralToken: token,
          ...(gatewaySessionIdRef.current ? { gatewaySessionId: gatewaySessionIdRef.current } : {}),
        }),
      });

      if (!sdpResp.ok) {
        const errText = await sdpResp.text().catch(() => '');
        console.error('[realtime] webrtc-connect failed', { status: sdpResp.status, body: errText.slice(0, 200) });
        fail('WEBRTC_FAILED', 'Falha na conexão com o serviço de IA. Tente novamente.');
        return;
      }

      const body = await sdpResp.json() as { sdp?: unknown };
      answerSdp = typeof body.sdp === 'string' ? body.sdp : '';
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
  }, [status, cleanup, fail, startRevealTimer, triggerLimitStop]);

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
    authorizedMaxSeconds, recordingLimitReason, stopMessage,
    recordingAuthorizationId,
    start, end, updateInstructions,
  };
}
