import { useState, useRef, useEffect, useCallback, MutableRefObject } from 'react';
import {
  ArrowLeft, Volume2, Mic, Square, Play, Pause,
  RefreshCw, Send, Loader2, CheckCircle, AlertCircle,
  RotateCcw, Lock,
} from 'lucide-react';
import { useAudioRecorder } from '../hooks/useAudioRecorder';
import { usePlanEntitlements } from '../hooks/usePlanEntitlements';
import { getAuthHeader } from '../lib/apiAuth';
import { convertToWavPcm, AudioConversionError } from '../lib/audioConverter';
import { createRecognitionSession, PronunciationServiceError } from '../lib/pronunciationService';
import {
  runTrainingAnalysisFlow,
  TRAINING_PHASE_MESSAGES,
  type TrainingAnalysisState,
  type TrainingFlowRefs,
} from '../lib/pronunciationTrainingFlow';
import { buildWordAlignment, type PronunciationWordDetail } from '../lib/pronunciationWordParser';
import {
  getWordTrainingCategory,
  needsPractice,
  TRAINING_CATEGORY_LABELS,
  TRAINING_CATEGORY_COLORS,
  type TrainingCategory,
} from '../lib/trainingWordCategory';
import type { PronunciationNormalizedResult } from '../types';
import { fetchAudioSettings, DEFAULT_AUDIO_SETTINGS, type AudioSettings } from '../lib/audioSettings';
import { apiUrl } from '../lib/apiUrl';
import { ENTITLEMENT_MESSAGES } from '../domain/entitlements/entitlement-messages';

// ── Utilities ─────────────────────────────────────────────────────────────────

type SessionStatus = 'text_generated' | 'processing' | 'completed' | 'failed_retryable' | 'failed_final';

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function cleanWordForTts(displayWord: string): string {
  return displayWord.replace(/^[^a-zA-Z0-9''-]+|[^a-zA-Z0-9''-]+$/g, '').trim();
}

async function fetchTtsUrl(text: string, voice: string): Promise<string> {
  const headers = await getAuthHeader();
  const resp = await fetch(apiUrl('/api/tts'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ text, voice }),
  });
  if (!resp.ok) throw new Error('TTS_FAILED');
  const blob = await resp.blob();
  return URL.createObjectURL(blob);
}

async function fetchAzureToken(): Promise<{ token: string; region: string }> {
  const headers = await getAuthHeader();
  const resp = await fetch(apiUrl('/api/pronunciation-training/token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
  });
  if (!resp.ok) {
    const j = await resp.json().catch(() => ({}));
    throw new Error((j as Record<string, string>).message ?? 'Token unavailable');
  }
  return resp.json();
}

// ── WordRow ───────────────────────────────────────────────────────────────────
// Per-word re-practice after results are shown — unrelated to the daily
// text/evaluation limits (a free-standing drill, not "um novo envio
// oficial"), so it keeps calling /token directly and is untouched by this
// task's limit enforcement.

interface WordRowProps {
  word: PronunciationWordDetail;
  currentCategory: TrainingCategory;
  wordTtsCacheRef: MutableRefObject<Map<string, string>>;
  sharedAudioRef: MutableRefObject<HTMLAudioElement | null>;
  voice: string;
  speed: AudioSettings['playbackRate'];
  activeRecordingWordId: string | null;
  onRecordingChange: (wordId: string | null) => void;
  onCategoryUpdate: (wordId: string, category: TrainingCategory) => void;
  onAudioStart: () => void;
}

function WordRow({
  word,
  currentCategory,
  wordTtsCacheRef,
  sharedAudioRef,
  voice,
  speed,
  activeRecordingWordId,
  onRecordingChange,
  onCategoryUpdate,
  onAudioStart,
}: WordRowProps) {
  const [ttsPhase, setTtsPhase]           = useState<'idle' | 'loading' | 'playing'>('idle');
  const [analysisState, setAnalysisState] = useState<'idle' | 'analyzing' | 'done' | 'error'>('idle');
  const [displayCategory, setDisplayCategory] = useState<TrainingCategory>(currentCategory);
  const [errorMsg, setErrorMsg]           = useState<string | null>(null);
  const [justGood, setJustGood]           = useState(false);

  const recorder     = useAudioRecorder();
  const mountedRef   = useRef(true);
  const myAudioRef   = useRef<HTMLAudioElement | null>(null);
  const cancelRef    = useRef<(() => void) | null>(null);
  const submittedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelRef.current?.();
      myAudioRef.current?.pause();
    };
  }, []);

  // Keep category in sync when parent re-analyses full text
  useEffect(() => { setDisplayCategory(currentCategory); }, [currentCategory]);

  // Auto-submit as soon as recording blob is ready
  useEffect(() => {
    if (recorder.phase === 'done' && recorder.audioBlob && !submittedRef.current) {
      submittedRef.current = true;
      runAnalysis(recorder.audioBlob, recorder.durationMs);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder.phase, recorder.audioBlob]);

  const cleanWord = cleanWordForTts(word.displayWord);
  const ttsKey    = cleanWord.toLowerCase();

  // ── TTS ───────────────────────────────────────────────────────────────────

  async function handlePlayWord() {
    if (ttsPhase === 'playing') {
      myAudioRef.current?.pause();
      setTtsPhase('idle');
      return;
    }
    if (sharedAudioRef.current && !sharedAudioRef.current.paused) {
      sharedAudioRef.current.pause();
    }
    onAudioStart();

    let url = wordTtsCacheRef.current.get(ttsKey);
    if (!url) {
      setTtsPhase('loading');
      try {
        url = await fetchTtsUrl(cleanWord, voice);
        if (!mountedRef.current) { URL.revokeObjectURL(url); return; }
        wordTtsCacheRef.current.set(ttsKey, url);
      } catch {
        if (mountedRef.current) setTtsPhase('idle');
        return;
      }
    }

    const audio = new Audio(url);
    audio.playbackRate = speed;
    myAudioRef.current = audio;
    sharedAudioRef.current = audio;
    audio.onended = () => { if (mountedRef.current) setTtsPhase('idle'); };
    audio.onerror = () => { if (mountedRef.current) setTtsPhase('idle'); };
    setTtsPhase('playing');
    audio.play().catch(() => { if (mountedRef.current) setTtsPhase('idle'); });
  }

  // ── Recording ─────────────────────────────────────────────────────────────

  function handleMicClick() {
    if (analysisState === 'analyzing') return;

    if (recorder.phase === 'recording') {
      recorder.stopRecording();
      return;
    }

    if (activeRecordingWordId !== null && activeRecordingWordId !== word.id) return;

    myAudioRef.current?.pause();
    setTtsPhase('idle');
    if (sharedAudioRef.current && !sharedAudioRef.current.paused) {
      sharedAudioRef.current.pause();
    }

    setErrorMsg(null);
    setJustGood(false);
    submittedRef.current = false;
    setAnalysisState('idle');
    recorder.deleteRecording();
    onRecordingChange(word.id);
    recorder.startRecording();
  }

  // ── Analysis ──────────────────────────────────────────────────────────────

  async function runAnalysis(audioBlob: Blob, audioDurationMs: number) {
    if (!mountedRef.current) return;
    setAnalysisState('analyzing');
    onRecordingChange(null);

    try {
      const { token, region } = await fetchAzureToken();
      const wavFile = await convertToWavPcm(audioBlob);
      const session = createRecognitionSession({ token, region, referenceText: cleanWord, wavFile, audioDurationMs });
      cancelRef.current = session.cancel;
      const result: PronunciationNormalizedResult = await session.run();
      cancelRef.current = null;
      if (!mountedRef.current) return;

      const { aligned } = buildWordAlignment(cleanWord, result.rawSegments);
      const newCat: TrainingCategory = aligned.length > 0 ? getWordTrainingCategory(aligned[0]) : 'pratique';
      setDisplayCategory(newCat);
      onCategoryUpdate(word.id, newCat);

      if (newCat === 'boa') {
        setJustGood(true);
        setTimeout(() => { if (mountedRef.current) setJustGood(false); }, 2500);
      }
      setAnalysisState('done');
      setTimeout(() => {
        if (mountedRef.current) { setAnalysisState('idle'); submittedRef.current = false; }
      }, 1500);
    } catch (err) {
      cancelRef.current = null;
      submittedRef.current = false;
      if (!mountedRef.current) return;

      let msg = 'Erro. Gravar novamente.';
      if (err instanceof PronunciationServiceError) {
        switch (err.code) {
          case 'AZURE_NO_MATCH':       msg = 'Fala não detectada.'; break;
          case 'AZURE_TIMEOUT':        msg = 'Análise demorou.'; break;
          case 'AZURE_NETWORK_ERROR':  msg = 'Serviço indisponível.'; break;
          case 'AZURE_CANCELED':       msg = 'Análise interrompida.'; break;
          case 'CLIENT_INTERRUPTED':   msg = 'Cancelado.'; break;
          case 'RESULT_INVALID':       msg = 'Resultado inválido.'; break;
        }
      } else if (err instanceof AudioConversionError) {
        msg = 'Áudio incompatível.';
      }
      setErrorMsg(msg);
      setAnalysisState('error');
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const isRecording  = recorder.phase === 'recording' || recorder.phase === 'requesting';
  const isAnalyzing  = analysisState === 'analyzing';
  const otherActive  = activeRecordingWordId !== null && activeRecordingWordId !== word.id;
  const micDisabled  = isAnalyzing || otherActive;

  const colors = TRAINING_CATEGORY_COLORS[displayCategory];
  const label  = TRAINING_CATEGORY_LABELS[displayCategory];

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 min-h-[52px]">
      {/* Word */}
      <span
        className="flex-1 min-w-0 text-sm font-medium text-slate-100 truncate"
        title={word.displayWord}
      >
        {word.displayWord}
      </span>

      {/* Badge */}
      <span
        className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-full border whitespace-nowrap transition-all ${colors.text} ${colors.bg} ${colors.border} ${justGood ? 'ring-1 ring-offset-1 ring-offset-slate-800 ring-green-500' : ''}`}
        aria-label={`Classificação: ${label}`}
      >
        {label}
      </span>

      {/* Speaker */}
      <button
        onClick={handlePlayWord}
        disabled={ttsPhase === 'loading' || isAnalyzing}
        className={`shrink-0 w-11 h-11 flex items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 disabled:cursor-not-allowed ${
          ttsPhase === 'playing'
            ? 'bg-blue-600 text-white'
            : 'bg-slate-700 hover:bg-slate-600 text-slate-300 hover:text-slate-100'
        }`}
        aria-label={ttsPhase === 'playing' ? `Parar áudio de ${word.displayWord}` : `Ouvir pronúncia de ${word.displayWord}`}
        title={`Ouvir pronúncia de ${word.displayWord}`}
      >
        {ttsPhase === 'loading'
          ? <Loader2 className="w-4 h-4 animate-spin" />
          : ttsPhase === 'playing'
            ? <Pause className="w-4 h-4" />
            : <Volume2 className="w-4 h-4" />
        }
      </button>

      {/* Mic */}
      <div className="shrink-0 flex flex-col items-center gap-0.5">
        <button
          onClick={handleMicClick}
          disabled={micDisabled}
          className={`w-11 h-11 flex items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 disabled:cursor-not-allowed ${
            isRecording
              ? 'bg-rose-700 text-white animate-pulse'
              : analysisState === 'done'
                ? 'bg-green-700 text-white'
                : 'bg-slate-700 hover:bg-slate-600 text-slate-300 hover:text-slate-100'
          }`}
          aria-label={
            isRecording
              ? `Parar gravação de ${word.displayWord}`
              : `Gravar pronúncia de ${word.displayWord}`
          }
          title={
            otherActive
              ? 'Aguarde a gravação anterior terminar'
              : isRecording
                ? `Parar gravação de ${word.displayWord}`
                : `Gravar pronúncia de ${word.displayWord}`
          }
        >
          {isAnalyzing
            ? <Loader2 className="w-4 h-4 animate-spin" />
            : isRecording
              ? <Square className="w-4 h-4" />
              : analysisState === 'done'
                ? <CheckCircle className="w-4 h-4" />
                : <Mic className="w-4 h-4" />
          }
        </button>
        {errorMsg && (
          <span className="text-[9px] text-red-400 leading-tight text-center max-w-[80px]">
            {errorMsg}
          </span>
        )}
      </div>
    </div>
  );
}

// ── PronunciationTrainingView ─────────────────────────────────────────────────

interface Props {
  onBack: () => void;
}

type MainPhase = 'generating' | 'ready' | 'results' | 'gen-error' | 'blocked';

export default function PronunciationTrainingView({ onBack }: Props) {
  const entitlementsState = usePlanEntitlements();
  const pronunciation = entitlementsState.data?.pronunciation ?? null;
  const maxRecordingMs = pronunciation && !pronunciation.maxRecordingUnlimited
    ? pronunciation.maxRecordingSeconds * 1000
    : undefined;
  // Sole source of truth for whether this account can keep training past the
  // one-round-per-day default — always the backend-resolved entitlement,
  // never inferred from local state. See handleGenerateText's `wantsNewRound`
  // (api/pronunciation-training/[...slug].ts), which independently re-checks
  // this same flag server-side before honoring `forceNew`.
  const unlimitedTraining = pronunciation?.evaluations.unlimited ?? false;

  const [mainPhase, setMainPhase]           = useState<MainPhase>('generating');
  const [blockedMessage, setBlockedMessage] = useState<string | null>(null);
  const [sessionId, setSessionId]           = useState<string | null>(null);
  const [sessionStatus, setSessionStatus]   = useState<SessionStatus | null>(null);
  const [generatedText, setGeneratedText]   = useState<string | null>(null);
  const [userLevel, setUserLevel]           = useState<string | null>(null);
  const [genError, setGenError]             = useState<string | null>(null);
  const [ttsPhase, setTtsPhase]             = useState<'idle' | 'loading' | 'playing' | 'error'>('idle');
  const [analysis, setAnalysis]             = useState<TrainingAnalysisState>({ phase: 'idle' });
  const [wordResults, setWordResults]       = useState<PronunciationWordDetail[] | null>(null);
  const [wordCategories, setWordCategories] = useState<Map<string, TrainingCategory>>(new Map());
  const [activeRecordingWordId, setActiveRecordingWordId] = useState<string | null>(null);
  const [audioVoice, setAudioVoice]         = useState<string>(DEFAULT_AUDIO_SETTINGS.voice);
  const [speed, setSpeed]                   = useState<AudioSettings['playbackRate']>(DEFAULT_AUDIO_SETTINGS.playbackRate);
  const [playbackPlaying, setPlaybackPlaying] = useState(false);

  const mountedRef        = useRef(true);
  const ttsUrlRef         = useRef<string | null>(null);
  const sharedAudioRef    = useRef<HTMLAudioElement | null>(null);
  const wordTtsCacheRef   = useRef<Map<string, string>>(new Map());
  const playbackAudioRef  = useRef<HTMLAudioElement | null>(null);
  const prevVoiceRef      = useRef<string>(DEFAULT_AUDIO_SETTINGS.voice);

  // Refs threaded into runTrainingAnalysisFlow — the same double-click /
  // concurrent-submission guard used by the writing flow's PronunciationRecorder.
  const flowLockRef           = useRef(false);
  const attemptIdRef          = useRef<string | null>(null);
  const sessionIdRef          = useRef<string | null>(null);
  const cancelRecognitionRef  = useRef<(() => void) | null>(null);
  const flowRefs: TrainingFlowRefs = { mountedRef, attemptIdRef, sessionIdRef, cancelRecognitionRef, flowLockRef };

  const recorder = useAudioRecorder(maxRecordingMs);

  // Load voice/speed from user settings on mount
  useEffect(() => {
    fetchAudioSettings().then(s => {
      if (!mountedRef.current) return;
      setAudioVoice(s.voice);
      setSpeed(s.playbackRate);
      prevVoiceRef.current = s.voice;
    }).catch(() => { /* use defaults */ });
  }, []);

  // Invalidate TTS cache when voice changes
  useEffect(() => {
    if (audioVoice === prevVoiceRef.current) return;
    prevVoiceRef.current = audioVoice;
    if (ttsUrlRef.current) { URL.revokeObjectURL(ttsUrlRef.current); ttsUrlRef.current = null; }
    wordTtsCacheRef.current.forEach(url => URL.revokeObjectURL(url));
    wordTtsCacheRef.current.clear();
  }, [audioVoice]);

  // Get-or-create today's text on mount; cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    doGenerateText();
    return () => {
      mountedRef.current = false;
      cancelRecognitionRef.current?.();
      sharedAudioRef.current?.pause();
      playbackAudioRef.current?.pause();
      if (ttsUrlRef.current) URL.revokeObjectURL(ttsUrlRef.current);
      wordTtsCacheRef.current.forEach(url => URL.revokeObjectURL(url));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Best-effort /fail + cancel recognition on unmount during an active submission
  useEffect(() => {
    return () => {
      cancelRecognitionRef.current?.();
      const sid  = sessionIdRef.current;
      const atid = attemptIdRef.current;
      if (sid && atid) {
        getAuthHeader().then((headers) => {
          fetch(apiUrl('/api/pronunciation-training/fail'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify({ sessionId: sid, attemptId: atid, code: 'CLIENT_INTERRUPTED' }),
          }).catch(() => undefined);
        }).catch(() => undefined);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doGenerateText = useCallback(async (forceNew = false) => {
    setMainPhase('generating');
    setGenError(null);
    setBlockedMessage(null);
    setWordResults(null);
    setWordCategories(new Map());
    setActiveRecordingWordId(null);
    setAnalysis({ phase: 'idle' });
    setTtsPhase('idle');
    setPlaybackPlaying(false);
    recorder.deleteRecording(); // never carry a previous round's recording into a fresh text

    try {
      const headers = await getAuthHeader();
      const resp = await fetch(apiUrl('/api/pronunciation-training/generate-text'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ forceNew }),
      });
      const json = await resp.json();
      if (!mountedRef.current) return;

      if (!resp.ok) {
        if (json.code === 'FEATURE_DISABLED' || json.code === 'DAILY_LIMIT_REACHED') {
          setBlockedMessage(json.message ?? ENTITLEMENT_MESSAGES.pronunciationTrainingTextAlreadyGeneratedToday);
          setMainPhase('blocked');
          return;
        }
        setGenError(json.message ?? 'Não foi possível gerar o texto. Tente novamente.');
        setMainPhase('gen-error');
        return;
      }

      setSessionId(json.sessionId as string);
      setSessionStatus(json.status as SessionStatus);
      setGeneratedText(json.text as string);
      setUserLevel(json.level as string ?? null);

      if (json.status === 'completed' && json.result) {
        const result = json.result as PronunciationNormalizedResult;
        const { aligned } = buildWordAlignment(json.text as string, result.rawSegments);
        setWordResults(aligned);
        setAnalysis({ phase: 'completed', result });
        setMainPhase('results');
      } else {
        setMainPhase('ready');
      }
    } catch {
      if (mountedRef.current) {
        setGenError('Erro de conexão. Verifique sua internet e tente novamente.');
        setMainPhase('gen-error');
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handlePlayFullText() {
    if (!generatedText) return;

    if (ttsPhase === 'playing') {
      sharedAudioRef.current?.pause();
      setTtsPhase('idle');
      return;
    }

    if (sharedAudioRef.current && !sharedAudioRef.current.paused) {
      sharedAudioRef.current.pause();
    }

    let url = ttsUrlRef.current;
    if (!url) {
      setTtsPhase('loading');
      try {
        url = await fetchTtsUrl(generatedText, audioVoice);
        if (!mountedRef.current) { URL.revokeObjectURL(url); return; }
        ttsUrlRef.current = url;
      } catch {
        if (mountedRef.current) setTtsPhase('error');
        return;
      }
    }

    const audio = new Audio(url);
    audio.playbackRate = speed;
    sharedAudioRef.current = audio;
    audio.onended = () => { if (mountedRef.current) setTtsPhase('idle'); };
    audio.onerror = () => { if (mountedRef.current) setTtsPhase('error'); };
    setTtsPhase('playing');
    audio.play().catch(() => { if (mountedRef.current) setTtsPhase('idle'); });
  }

  function handlePlayMyRecording() {
    if (!recorder.audioUrl) return;
    if (playbackPlaying) {
      playbackAudioRef.current?.pause();
      setPlaybackPlaying(false);
      return;
    }
    const audio = new Audio(recorder.audioUrl);
    playbackAudioRef.current = audio;
    audio.onended = () => { if (mountedRef.current) setPlaybackPlaying(false); };
    audio.onerror = () => { if (mountedRef.current) setPlaybackPlaying(false); };
    setPlaybackPlaying(true);
    audio.play().catch(() => { if (mountedRef.current) setPlaybackPlaying(false); });
  }

  const handleAnalyzeFull = useCallback(() => {
    if (flowLockRef.current) return;
    if (sessionStatus === 'completed') return; // frontend guard only — backend re-checks and blocks regardless
    if (recorder.phase !== 'done' || !recorder.audioBlob) return;
    flowLockRef.current = true;

    const attemptId = crypto.randomUUID();
    sharedAudioRef.current?.pause();
    setTtsPhase('idle');
    playbackAudioRef.current?.pause();
    setPlaybackPlaying(false);

    void runTrainingAnalysisFlow(
      { attemptId, audioBlob: recorder.audioBlob, audioDurationMs: recorder.durationMs },
      flowRefs,
      (state) => {
        if (!mountedRef.current) return;
        setAnalysis(state);
        if (state.phase === 'completed' && state.result) {
          setSessionStatus('completed');
          const { aligned } = buildWordAlignment(generatedText ?? '', state.result.rawSegments);
          setWordResults(aligned);
          setWordCategories(new Map());
          setActiveRecordingWordId(null);
          setMainPhase('results');
        }
      },
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionStatus, recorder.phase, recorder.audioBlob, recorder.durationMs, generatedText]);

  function handleRetryAnalysis() {
    sessionIdRef.current = null;
    attemptIdRef.current = null;
    setAnalysis({ phase: 'idle' });
  }

  const handleWordCategoryUpdate = useCallback((wordId: string, cat: TrainingCategory) => {
    setWordCategories(prev => { const m = new Map(prev); m.set(wordId, cat); return m; });
  }, []);

  const handleWordAudioStart = useCallback(() => {
    sharedAudioRef.current?.pause();
    setTtsPhase('idle');
  }, []);

  const handleWordRecordingChange = useCallback((wordId: string | null) => {
    setActiveRecordingWordId(wordId);
  }, []);

  // ── Derived state ─────────────────────────────────────────────────────────

  const isSubmitting =
    analysis.phase === 'preparing_audio' ||
    analysis.phase === 'reserving'       ||
    analysis.phase === 'analyzing'       ||
    analysis.phase === 'saving_result';

  const isCompletedToday = sessionStatus === 'completed';

  // Once a text exists for today there is, by default, never a second one —
  // "Gerar outro texto" stays disabled for the rest of the day regardless of
  // whether the evaluation itself has been submitted yet. The one exception:
  // an unlimited-plan account that already finished today's round may start
  // another — the backend independently re-verifies
  // pronunciation.evaluations.unlimited before honoring this (never trusts
  // this frontend flag alone).
  const canStartAnotherRound = unlimitedTraining && isCompletedToday;
  const generateNewDisabled = sessionId !== null && !canStartAnotherRound;

  const canSubmit =
    recorder.phase === 'done'    &&
    recorder.audioBlob !== null  &&
    !isSubmitting                &&
    analysis.phase !== 'completed' &&
    !isCompletedToday;

  const practiceWords = (wordResults ?? []).filter(w => needsPractice(w));

  const summaryCounts = wordResults ? wordResults.reduce(
    (acc, w) => {
      const cat = wordCategories.get(w.id) ?? getWordTrainingCategory(w);
      acc[cat]++;
      return acc;
    },
    { boa: 0, 'pode-melhorar': 0, pratique: 0 } as Record<TrainingCategory, number>,
  ) : null;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="p-4 pt-6 max-w-2xl mx-auto pb-16">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={onBack}
          className="p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
          aria-label="Voltar"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-xl font-bold text-slate-100">Treinar pronúncia</h1>
          <p className="text-xs text-slate-400 mt-0.5">Leia, grave e descubra quais palavras precisam de atenção.</p>
        </div>
      </div>

      {/* ── Generating ─────────────────────────────────────────────────── */}
      {mainPhase === 'generating' && (
        <div className="flex flex-col items-center py-20 gap-3">
          <Loader2 className="w-8 h-8 text-blue-400 animate-spin" />
          <p className="text-slate-400 text-sm">Gerando seu texto de treino…</p>
        </div>
      )}

      {/* ── Blocked by plan (feature off, or a hypothetical 0/day limit) ─── */}
      {mainPhase === 'blocked' && (
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-5 text-center space-y-2">
          <Lock className="w-6 h-6 text-amber-400 mx-auto" />
          <p className="text-sm text-slate-300">{blockedMessage ?? ENTITLEMENT_MESSAGES.featureUnavailable}</p>
        </div>
      )}

      {/* ── Generation error ────────────────────────────────────────────── */}
      {mainPhase === 'gen-error' && (
        <div className="bg-red-900/30 border border-red-700 rounded-xl p-5 text-center">
          <AlertCircle className="w-6 h-6 text-red-400 mx-auto mb-2" />
          <p className="text-sm text-red-300 mb-4">{genError}</p>
          <button
            onClick={() => doGenerateText()}
            className="px-5 py-2 bg-slate-700 hover:bg-slate-600 text-slate-100 text-sm rounded-lg transition-colors"
          >
            Tentar novamente
          </button>
        </div>
      )}

      {/* ── Training session ─────────────────────────────────────────────── */}
      {(mainPhase === 'ready' || mainPhase === 'results') && generatedText && (
        <>
          {/* Level + Generate new button (disabled once today's text exists, unless the plan allows unlimited rounds) */}
          <div className="flex items-center justify-between mb-1">
            <span className="inline-flex items-center text-xs font-medium px-2.5 py-1 rounded-full bg-blue-900/40 border border-blue-700 text-blue-300">
              Nível {userLevel ?? '—'}
            </span>
            <button
              onClick={() => doGenerateText(true)}
              disabled={generateNewDisabled}
              aria-disabled={generateNewDisabled}
              title={generateNewDisabled ? ENTITLEMENT_MESSAGES.pronunciationTrainingTextAlreadyGeneratedToday : undefined}
              className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-slate-400"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Gerar outro texto
            </button>
          </div>
          {generateNewDisabled && (
            <p className="text-xs text-slate-500 mb-4">{ENTITLEMENT_MESSAGES.pronunciationTrainingTextAlreadyGeneratedToday}</p>
          )}

          {/* Generated text (plain or annotated) */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-4">
            {mainPhase === 'results' && wordResults ? (
              <div className="flex flex-wrap gap-x-2 gap-y-2 leading-loose" aria-label="Texto com avaliação por palavra">
                {wordResults.map(w => {
                  const cat    = wordCategories.get(w.id) ?? getWordTrainingCategory(w);
                  const colors = TRAINING_CATEGORY_COLORS[cat];
                  const lbl    = TRAINING_CATEGORY_LABELS[cat];
                  return (
                    <span
                      key={w.id}
                      className={`inline-flex flex-col items-center px-1.5 py-0.5 rounded border ${colors.bg} ${colors.border}`}
                      aria-label={`${w.displayWord}: ${lbl}`}
                    >
                      <span className="text-sm text-slate-100 leading-snug">{w.displayWord}</span>
                      <span className={`text-[9px] font-bold uppercase tracking-wide leading-none mt-0.5 ${colors.text}`}>{lbl}</span>
                    </span>
                  );
                })}
              </div>
            ) : (
              <p className="text-slate-100 text-sm leading-relaxed">{generatedText}</p>
            )}
          </div>

          {/* TTS — listen to text + speed selector */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <button
              onClick={handlePlayFullText}
              disabled={ttsPhase === 'loading'}
              className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-100 text-sm rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label={ttsPhase === 'playing' ? 'Parar reprodução do texto' : 'Ouvir pronúncia do texto completo'}
            >
              {ttsPhase === 'loading' && <Loader2 className="w-4 h-4 animate-spin" />}
              {ttsPhase === 'playing' && <Pause className="w-4 h-4" />}
              {(ttsPhase === 'idle' || ttsPhase === 'error') && <Volume2 className="w-4 h-4" />}
              {ttsPhase === 'loading' ? 'Carregando áudio…' : ttsPhase === 'playing' ? 'Parar áudio' : 'Ouvir texto'}
            </button>
            <div className="flex items-center gap-1" aria-label="Velocidade de reprodução">
              {([0.75, 0.9, 1] as const).map(s => (
                <button
                  key={s}
                  onClick={() => setSpeed(s)}
                  className={`text-xs px-2.5 py-1.5 rounded-lg transition-colors ${
                    speed === s
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-700 text-slate-400 hover:text-slate-100'
                  }`}
                  aria-pressed={speed === s}
                  aria-label={`Velocidade ${s}×`}
                >
                  {s}×
                </button>
              ))}
            </div>
            {ttsPhase === 'error' && (
              <span className="text-xs text-red-400">Erro ao reproduzir o áudio.</span>
            )}
          </div>

          {/* ── Daily evaluation already completed: saved result only, no re-record ── */}
          {isCompletedToday && (
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-4 flex items-center gap-3">
              <CheckCircle className="w-5 h-5 text-green-400 shrink-0" aria-hidden="true" />
              <p className="text-sm text-slate-200">
                {canStartAnotherRound
                  ? ENTITLEMENT_MESSAGES.pronunciationTrainingUnlimitedReadyForAnotherRound
                  : ENTITLEMENT_MESSAGES.pronunciationTrainingDailyEvaluationCompleted}
              </p>
            </div>
          )}

          {/* Recording section — only while today's evaluation isn't completed yet */}
          {!isCompletedToday && (
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-4">
              <h2 className="text-sm font-semibold text-slate-200 mb-3">Sua leitura</h2>

              {isSubmitting ? (
                <div className="flex items-center gap-3 py-3">
                  <Loader2 className="w-5 h-5 text-blue-400 animate-spin shrink-0" />
                  <span className="text-sm text-slate-300">{TRAINING_PHASE_MESSAGES[analysis.phase]}</span>
                </div>
              ) : (
                <div className="space-y-3">
                  {(recorder.phase === 'idle' || recorder.phase === 'error') && (
                    <button
                      onClick={recorder.startRecording}
                      className="flex items-center gap-2 px-4 py-2 bg-rose-700 hover:bg-rose-600 text-white text-sm rounded-lg transition-colors"
                      aria-label="Gravar leitura do texto"
                    >
                      <Mic className="w-4 h-4" />
                      {recorder.phase === 'error' ? 'Tentar novamente' : 'Gravar leitura'}
                    </button>
                  )}

                  {recorder.phase === 'requesting' && (
                    <div className="flex items-center gap-2 px-4 py-2 bg-slate-700 text-slate-400 text-sm rounded-lg w-fit">
                      <Loader2 className="w-4 h-4 animate-spin" /> Aguardando microfone…
                    </div>
                  )}

                  {recorder.phase === 'recording' && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className="flex items-center gap-2 px-3 py-2 bg-rose-900/40 border border-rose-700 rounded-lg text-rose-300 text-xs font-mono"
                        aria-live="polite"
                        aria-label={`Gravando: ${formatTime(recorder.elapsedMs)}${maxRecordingMs ? ` de ${formatTime(maxRecordingMs)}` : ''}`}
                      >
                        <span className="w-2 h-2 bg-rose-400 rounded-full animate-pulse" aria-hidden="true" />
                        {formatTime(recorder.elapsedMs)}{maxRecordingMs ? ` / ${formatTime(maxRecordingMs)}` : ''}
                      </span>
                      <button
                        onClick={recorder.stopRecording}
                        className="flex items-center gap-2 px-4 py-2 bg-rose-700 hover:bg-rose-600 text-white text-sm rounded-lg transition-colors"
                        aria-label="Parar gravação"
                      >
                        <Square className="w-4 h-4" /> Parar gravação
                      </button>
                    </div>
                  )}

                  {recorder.phase === 'done' && analysis.phase !== 'failed' && (
                    <div className="space-y-3">
                      {recorder.stoppedByMaxDuration && pronunciation && !pronunciation.maxRecordingUnlimited && (
                        <p className="text-xs text-amber-400">
                          {ENTITLEMENT_MESSAGES.recordingLimitReached(pronunciation.maxRecordingSeconds)}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={handlePlayMyRecording}
                          className="flex items-center gap-2 px-3 py-2 bg-slate-700 hover:bg-slate-600 text-slate-100 text-sm rounded-lg transition-colors"
                          aria-label={playbackPlaying ? 'Parar reprodução da sua gravação' : 'Ouvir sua gravação'}
                        >
                          {playbackPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                          {playbackPlaying ? 'Parar' : 'Ouvir gravação'}
                        </button>
                        <button
                          onClick={recorder.startRecording}
                          className="flex items-center gap-2 px-3 py-2 bg-slate-700 hover:bg-slate-600 text-slate-100 text-sm rounded-lg transition-colors"
                          aria-label="Descartar gravação atual e gravar novamente"
                        >
                          <RotateCcw className="w-4 h-4" /> Gravar novamente
                        </button>
                        <button
                          onClick={handleAnalyzeFull}
                          disabled={!canSubmit}
                          aria-disabled={!canSubmit}
                          className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-500 hover:to-blue-600 text-white text-sm font-medium rounded-lg transition-all shadow-lg shadow-blue-900/30 disabled:opacity-40 disabled:cursor-not-allowed"
                          aria-label="Enviar gravação para análise de pronúncia"
                        >
                          <Send className="w-4 h-4" /> Enviar para análise
                        </button>
                      </div>
                    </div>
                  )}

                  {recorder.errorMessage && (
                    <p className="text-xs text-red-400">{recorder.errorMessage}</p>
                  )}
                  {analysis.phase === 'failed' && analysis.errorMessage && (
                    <div className="bg-red-900/30 border border-red-700 rounded-xl p-4 space-y-3">
                      <p className="text-sm text-red-200">{analysis.errorMessage}</p>
                      <button
                        onClick={handleRetryAnalysis}
                        className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-100 text-sm rounded-lg transition-colors"
                      >
                        <RotateCcw className="w-4 h-4" /> Gravar novamente
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Results ──────────────────────────────────────────────────── */}
          {mainPhase === 'results' && wordResults && summaryCounts && (
            <>
              {/* Summary counts */}
              <div className="grid grid-cols-3 gap-3 mb-4">
                <div className="bg-green-900/20 border border-green-800 rounded-xl p-3 text-center">
                  <div className="text-2xl font-bold text-green-400">{summaryCounts['boa']}</div>
                  <div className="text-xs text-green-500 mt-0.5">Boa</div>
                </div>
                <div className="bg-yellow-900/20 border border-yellow-800 rounded-xl p-3 text-center">
                  <div className="text-2xl font-bold text-yellow-400">{summaryCounts['pode-melhorar']}</div>
                  <div className="text-xs text-yellow-500 mt-0.5">Pode melhorar</div>
                </div>
                <div className="bg-red-900/20 border border-red-800 rounded-xl p-3 text-center">
                  <div className="text-2xl font-bold text-red-400">{summaryCounts['pratique']}</div>
                  <div className="text-xs text-red-500 mt-0.5">Pratique</div>
                </div>
              </div>

              {/* Word practice area */}
              {practiceWords.length === 0 ? (
                <div className="flex flex-col items-center py-10 gap-2 text-center">
                  <CheckCircle className="w-8 h-8 text-green-400" />
                  <p className="text-slate-100 font-semibold">Excelente pronúncia!</p>
                  <p className="text-slate-400 text-sm">Todas as palavras foram reconhecidas corretamente.</p>
                </div>
              ) : (
                <div>
                  <h2 className="text-base font-semibold text-slate-100 mb-3">
                    Palavras para praticar
                    <span className="ml-2 text-sm font-normal text-slate-400">({practiceWords.length})</span>
                  </h2>
                  <div className="bg-slate-800 border border-slate-700 rounded-xl divide-y divide-slate-700/50 overflow-hidden">
                    {practiceWords.map(w => {
                      const cat = wordCategories.get(w.id) ?? getWordTrainingCategory(w);
                      return (
                        <WordRow
                          key={w.id}
                          word={w}
                          currentCategory={cat}
                          wordTtsCacheRef={wordTtsCacheRef}
                          sharedAudioRef={sharedAudioRef}
                          voice={audioVoice}
                          speed={speed}
                          activeRecordingWordId={activeRecordingWordId}
                          onRecordingChange={handleWordRecordingChange}
                          onCategoryUpdate={handleWordCategoryUpdate}
                          onAudioStart={handleWordAudioStart}
                        />
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
