import { useState, useRef, useEffect, useCallback, MutableRefObject } from 'react';
import {
  ArrowLeft, Volume2, Mic, Square, Play, Pause,
  RefreshCw, Send, Loader2, CheckCircle, AlertCircle,
  ChevronDown, ChevronUp, RotateCcw,
} from 'lucide-react';
import { useAudioRecorder } from '../hooks/useAudioRecorder';
import { getAuthHeader } from '../lib/apiAuth';
import { convertToWavPcm, AudioConversionError } from '../lib/audioConverter';
import { createRecognitionSession, PronunciationServiceError } from '../lib/pronunciationService';
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

// ── Utilities ─────────────────────────────────────────────────────────────────

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function cleanWordForTts(displayWord: string): string {
  return displayWord.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '').trim();
}

async function fetchTtsUrl(text: string, voice: string): Promise<string> {
  const headers = await getAuthHeader();
  const resp = await fetch('/api/tts', {
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
  const resp = await fetch('/api/pronunciation-training/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
  });
  if (!resp.ok) {
    const j = await resp.json().catch(() => ({}));
    throw new Error((j as Record<string, string>).message ?? 'Token unavailable');
  }
  return resp.json();
}

// ── WordTrainer ───────────────────────────────────────────────────────────────

interface WordTrainerProps {
  word: PronunciationWordDetail;
  currentCategory: TrainingCategory;
  wordTtsCacheRef: MutableRefObject<Map<string, string>>;
  sharedAudioRef: MutableRefObject<HTMLAudioElement | null>;
  onAudioStart: () => void;
  onCategoryUpdate: (wordId: string, category: TrainingCategory) => void;
  voice: string;
  speed: AudioSettings['playbackRate'];
}

function WordTrainer({
  word,
  currentCategory,
  wordTtsCacheRef,
  sharedAudioRef,
  onAudioStart,
  onCategoryUpdate,
  voice,
  speed,
}: WordTrainerProps) {
  const recorder = useAudioRecorder();
  const [ttsPhase, setTtsPhase] = useState<'idle' | 'loading' | 'playing' | 'error'>('idle');
  const [analysisPhase, setAnalysisPhase] = useState<'idle' | 'analyzing' | 'done' | 'error'>('idle');
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [displayCategory, setDisplayCategory] = useState<TrainingCategory>(currentCategory);
  const [justReachedGood, setJustReachedGood] = useState(false);
  const [playbackPlaying, setPlaybackPlaying] = useState(false);

  const mountedRef = useRef(true);
  const cancelAnalysisRef = useRef<(() => void) | null>(null);
  const myAudioRef = useRef<HTMLAudioElement | null>(null);
  const playbackAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelAnalysisRef.current?.();
      myAudioRef.current?.pause();
      playbackAudioRef.current?.pause();
    };
  }, []);

  // Keep display category in sync when parent updates it (e.g. full-text re-analysis)
  useEffect(() => { setDisplayCategory(currentCategory); }, [currentCategory]);

  const cleanWord = cleanWordForTts(word.displayWord);
  const ttsKey = cleanWord.toLowerCase();

  async function handlePlayWord() {
    if (ttsPhase === 'playing') {
      myAudioRef.current?.pause();
      setTtsPhase('idle');
      return;
    }

    // Stop any other audio
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
        if (mountedRef.current) setTtsPhase('error');
        return;
      }
    }

    const audio = new Audio(url);
    audio.playbackRate = speed;
    myAudioRef.current = audio;
    sharedAudioRef.current = audio;
    audio.onended  = () => { if (mountedRef.current) setTtsPhase('idle'); };
    audio.onerror  = () => { if (mountedRef.current) setTtsPhase('error'); };
    setTtsPhase('playing');
    audio.play().catch(() => { if (mountedRef.current) setTtsPhase('idle'); });
  }

  function handlePlayRecording() {
    if (!recorder.audioUrl) return;
    if (playbackPlaying) {
      playbackAudioRef.current?.pause();
      setPlaybackPlaying(false);
      return;
    }
    const audio = new Audio(recorder.audioUrl);
    playbackAudioRef.current = audio;
    audio.onended  = () => { if (mountedRef.current) setPlaybackPlaying(false); };
    audio.onerror  = () => { if (mountedRef.current) setPlaybackPlaying(false); };
    setPlaybackPlaying(true);
    audio.play().catch(() => { if (mountedRef.current) setPlaybackPlaying(false); });
  }

  async function handleAnalyze() {
    const audioBlob = recorder.audioBlob;
    const audioDurationMs = recorder.durationMs;
    if (!audioBlob || recorder.phase !== 'done') return;
    if (analysisPhase === 'analyzing') return;

    setAnalysisPhase('analyzing');
    setAnalysisError(null);
    setJustReachedGood(false);

    try {
      const { token, region } = await fetchAzureToken();
      const wavFile = await convertToWavPcm(audioBlob);

      const session = createRecognitionSession({
        token,
        region,
        referenceText: cleanWord,
        wavFile,
        audioDurationMs,
      });
      cancelAnalysisRef.current = session.cancel;
      const result: PronunciationNormalizedResult = await session.run();
      cancelAnalysisRef.current = null;
      if (!mountedRef.current) return;

      const { aligned } = buildWordAlignment(cleanWord, result.rawSegments);
      const newCat: TrainingCategory =
        aligned.length > 0 ? getWordTrainingCategory(aligned[0]) : 'pratique';

      setDisplayCategory(newCat);
      onCategoryUpdate(word.id, newCat);
      if (newCat === 'boa') setJustReachedGood(true);
      setAnalysisPhase('done');
    } catch (err) {
      cancelAnalysisRef.current = null;
      if (!mountedRef.current) return;

      let msg = 'Erro na análise. Tente novamente.';
      if (err instanceof PronunciationServiceError) {
        if (err.code === 'AZURE_NO_MATCH')
          msg = 'Nenhuma fala detectada. Grave novamente e tente outra vez.';
        else if (err.code === 'AZURE_TIMEOUT')
          msg = 'A análise demorou demais. Tente novamente.';
      } else if (err instanceof AudioConversionError) {
        msg = 'Não foi possível preparar o áudio. Grave novamente.';
      }
      setAnalysisError(msg);
      setAnalysisPhase('error');
    }
  }

  const colors = TRAINING_CATEGORY_COLORS[displayCategory];
  const label  = TRAINING_CATEGORY_LABELS[displayCategory];

  return (
    <div className="space-y-3">
      {/* Category badge */}
      <div className="flex items-center gap-2">
        <span
          className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${colors.text} ${colors.bg} ${colors.border}`}
          aria-label={`Classificação atual: ${label}`}
        >
          {label}
        </span>
        {justReachedGood && (
          <span className="flex items-center gap-1 text-xs text-green-400">
            <CheckCircle className="w-3.5 h-3.5" /> Pronúncia aprovada!
          </span>
        )}
      </div>

      {/* Listen word button */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={handlePlayWord}
          disabled={ttsPhase === 'loading'}
          className="flex items-center gap-1.5 text-sm px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-100 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          aria-label={ttsPhase === 'playing' ? 'Parar áudio da palavra' : 'Ouvir pronúncia da palavra'}
        >
          {ttsPhase === 'loading' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {ttsPhase === 'playing' && <Pause className="w-3.5 h-3.5" />}
          {(ttsPhase === 'idle' || ttsPhase === 'error') && <Volume2 className="w-3.5 h-3.5" />}
          {ttsPhase === 'loading' ? 'Carregando…' : ttsPhase === 'playing' ? 'Parar' : 'Ouvir palavra'}
        </button>
        {ttsPhase === 'error' && (
          <span className="text-xs text-red-400 self-center">Erro ao reproduzir.</span>
        )}
      </div>

      {/* Recording controls */}
      <div className="flex flex-wrap gap-2">
        {(recorder.phase === 'idle' || recorder.phase === 'error') && (
          <button
            onClick={recorder.startRecording}
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 bg-rose-700 hover:bg-rose-600 text-white rounded-lg transition-colors"
            aria-label="Gravar pronúncia desta palavra"
          >
            <Mic className="w-3.5 h-3.5" /> Gravar palavra
          </button>
        )}

        {recorder.phase === 'requesting' && (
          <span className="flex items-center gap-1.5 text-sm px-3 py-1.5 bg-slate-700 text-slate-400 rounded-lg cursor-wait">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Aguardando microfone…
          </span>
        )}

        {recorder.phase === 'recording' && (
          <>
            <span className="flex items-center gap-1.5 px-2.5 py-1.5 bg-rose-900/40 border border-rose-700 rounded-lg text-rose-300 text-xs font-mono" aria-live="polite">
              <span className="w-2 h-2 bg-rose-400 rounded-full animate-pulse" aria-hidden="true" />
              {formatTime(recorder.elapsedMs)}
            </span>
            <button
              onClick={recorder.stopRecording}
              className="flex items-center gap-1.5 text-sm px-3 py-1.5 bg-rose-700 hover:bg-rose-600 text-white rounded-lg transition-colors"
              aria-label="Parar gravação"
            >
              <Square className="w-3.5 h-3.5" /> Parar gravação
            </button>
          </>
        )}

        {recorder.phase === 'done' && (
          <>
            <button
              onClick={handlePlayRecording}
              className="flex items-center gap-1.5 text-sm px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-100 rounded-lg transition-colors"
              aria-label={playbackPlaying ? 'Parar reprodução' : 'Ouvir sua gravação'}
            >
              {playbackPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              {playbackPlaying ? 'Parar' : 'Ouvir gravação'}
            </button>

            <button
              onClick={() => { setPlaybackPlaying(false); recorder.deleteRecording(); setAnalysisPhase('idle'); setAnalysisError(null); }}
              className="flex items-center gap-1.5 text-sm px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-100 rounded-lg transition-colors"
              aria-label="Gravar palavra novamente"
            >
              <RotateCcw className="w-3.5 h-3.5" /> Gravar novamente
            </button>

            <button
              onClick={handleAnalyze}
              disabled={analysisPhase === 'analyzing'}
              className="flex items-center gap-1.5 text-sm px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Analisar pronúncia desta palavra"
            >
              {analysisPhase === 'analyzing'
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Send className="w-3.5 h-3.5" />}
              {analysisPhase === 'analyzing' ? 'Analisando…' : 'Analisar palavra'}
            </button>
          </>
        )}
      </div>

      {recorder.errorMessage && (
        <p className="text-xs text-red-400">{recorder.errorMessage}</p>
      )}
      {analysisError && (
        <p className="text-xs text-red-400">{analysisError}</p>
      )}
    </div>
  );
}

// ── PronunciationTrainingView ─────────────────────────────────────────────────

interface Props {
  onBack: () => void;
}

type MainPhase = 'generating' | 'ready' | 'results' | 'gen-error';
type TtsPhase  = 'idle' | 'loading' | 'playing' | 'error';
type AnalysisPhase = 'idle' | 'preparing' | 'analyzing' | 'error';

export default function PronunciationTrainingView({ onBack }: Props) {
  const [mainPhase, setMainPhase]         = useState<MainPhase>('generating');
  const [generatedText, setGeneratedText] = useState<string | null>(null);
  const [userLevel, setUserLevel]         = useState<string | null>(null);
  const [genError, setGenError]           = useState<string | null>(null);
  const [ttsPhase, setTtsPhase]           = useState<TtsPhase>('idle');
  const [analysisPhase, setAnalysisPhase] = useState<AnalysisPhase>('idle');
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [wordResults, setWordResults]     = useState<PronunciationWordDetail[] | null>(null);
  const [wordCategories, setWordCategories] = useState<Map<string, TrainingCategory>>(new Map());
  const [selectedWordId, setSelectedWordId] = useState<string | null>(null);
  const [audioVoice, setAudioVoice] = useState<string>(DEFAULT_AUDIO_SETTINGS.voice);
  const [speed, setSpeed] = useState<AudioSettings['playbackRate']>(DEFAULT_AUDIO_SETTINGS.playbackRate);

  const mountedRef       = useRef(true);
  const ttsUrlRef        = useRef<string | null>(null);
  const sharedAudioRef   = useRef<HTMLAudioElement | null>(null);
  const wordTtsCacheRef  = useRef<Map<string, string>>(new Map());
  const cancelAnalysisRef = useRef<(() => void) | null>(null);
  const playbackAudioRef = useRef<HTMLAudioElement | null>(null);
  const prevVoiceRef     = useRef<string>(DEFAULT_AUDIO_SETTINGS.voice);
  const [playbackPlaying, setPlaybackPlaying] = useState(false);

  const recorder = useAudioRecorder();

  // Load voice/speed from user settings on mount
  useEffect(() => {
    fetchAudioSettings().then(s => {
      if (!mountedRef.current) return;
      setAudioVoice(s.voice);
      setSpeed(s.playbackRate);
      prevVoiceRef.current = s.voice;
    }).catch(() => { /* use defaults */ });
  }, []);

  // Invalidate TTS cache whenever the user's chosen voice changes
  useEffect(() => {
    if (audioVoice === prevVoiceRef.current) return;
    prevVoiceRef.current = audioVoice;
    if (ttsUrlRef.current) { URL.revokeObjectURL(ttsUrlRef.current); ttsUrlRef.current = null; }
    wordTtsCacheRef.current.forEach(url => URL.revokeObjectURL(url));
    wordTtsCacheRef.current.clear();
  }, [audioVoice]);

  // Generate text on mount; cleanup all resources on unmount
  useEffect(() => {
    mountedRef.current = true;
    doGenerateText();
    return () => {
      mountedRef.current = false;
      cancelAnalysisRef.current?.();
      sharedAudioRef.current?.pause();
      playbackAudioRef.current?.pause();
      if (ttsUrlRef.current) URL.revokeObjectURL(ttsUrlRef.current);
      wordTtsCacheRef.current.forEach(url => URL.revokeObjectURL(url));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doGenerateText = useCallback(async () => {
    setMainPhase('generating');
    setGenError(null);
    setWordResults(null);
    setWordCategories(new Map());
    setSelectedWordId(null);
    setAnalysisPhase('idle');
    setAnalysisError(null);
    setTtsPhase('idle');
    setPlaybackPlaying(false);

    try {
      const headers = await getAuthHeader();
      const resp = await fetch('/api/pronunciation-training/generate-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
      });
      const json = await resp.json();
      if (!mountedRef.current) return;
      if (!resp.ok || !json.text) {
        setGenError(json.message ?? 'Não foi possível gerar o texto. Tente novamente.');
        setMainPhase('gen-error');
        return;
      }
      setGeneratedText(json.text as string);
      setUserLevel(json.level as string ?? null);
      setMainPhase('ready');
    } catch {
      if (mountedRef.current) {
        setGenError('Erro de conexão. Verifique sua internet e tente novamente.');
        setMainPhase('gen-error');
      }
    }
  }, []);

  function handleGenerateNew() {
    const hasRecording = recorder.phase === 'recording' || recorder.phase === 'done';
    const hasResults   = wordResults !== null;
    if ((hasRecording || hasResults) && !window.confirm('Isso vai descartar sua gravação e análise atuais. Continuar?')) return;

    cancelAnalysisRef.current?.();
    cancelAnalysisRef.current = null;
    recorder.deleteRecording();
    playbackAudioRef.current?.pause();
    setPlaybackPlaying(false);

    sharedAudioRef.current?.pause();
    setTtsPhase('idle');

    if (ttsUrlRef.current) { URL.revokeObjectURL(ttsUrlRef.current); ttsUrlRef.current = null; }

    doGenerateText();
  }

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

  async function handleAnalyzeFull() {
    const audioBlob = recorder.audioBlob;
    const audioDurationMs = recorder.durationMs;
    const refText = generatedText;
    if (!refText || !audioBlob || recorder.phase !== 'done') return;
    if (analysisPhase === 'preparing' || analysisPhase === 'analyzing') return;

    setAnalysisPhase('preparing');
    setAnalysisError(null);
    sharedAudioRef.current?.pause();
    setTtsPhase('idle');
    playbackAudioRef.current?.pause();
    setPlaybackPlaying(false);

    try {
      const { token, region } = await fetchAzureToken();

      setAnalysisPhase('analyzing');

      const wavFile = await convertToWavPcm(audioBlob);

      const session = createRecognitionSession({
        token,
        region,
        referenceText: refText,
        wavFile,
        audioDurationMs,
      });
      cancelAnalysisRef.current = session.cancel;
      const result: PronunciationNormalizedResult = await session.run();
      cancelAnalysisRef.current = null;
      if (!mountedRef.current) return;

      const { aligned } = buildWordAlignment(refText, result.rawSegments);
      setWordResults(aligned);
      setWordCategories(new Map());
      setSelectedWordId(null);
      setMainPhase('results');
      setAnalysisPhase('idle');
    } catch (err) {
      cancelAnalysisRef.current = null;
      if (!mountedRef.current) return;

      let msg = 'Erro na análise. Tente novamente.';
      if (err instanceof PronunciationServiceError) {
        if (err.code === 'AZURE_NO_MATCH')
          msg = 'Nenhuma fala detectada. Verifique o microfone e tente novamente.';
        else if (err.code === 'AZURE_TIMEOUT')
          msg = 'A análise demorou demais. Tente novamente.';
      } else if (err instanceof AudioConversionError) {
        msg = 'Não foi possível preparar a gravação. Grave novamente.';
      }
      setAnalysisError(msg);
      setAnalysisPhase('error');
    }
  }

  function handleRerecordFull() {
    playbackAudioRef.current?.pause();
    setPlaybackPlaying(false);
    recorder.deleteRecording();
    setWordResults(null);
    setWordCategories(new Map());
    setSelectedWordId(null);
    setAnalysisPhase('idle');
    setAnalysisError(null);
    setMainPhase('ready');
  }

  const handleWordCategoryUpdate = useCallback((wordId: string, cat: TrainingCategory) => {
    setWordCategories(prev => { const m = new Map(prev); m.set(wordId, cat); return m; });
  }, []);

  const handleWordAudioStart = useCallback(() => {
    sharedAudioRef.current?.pause();
    setTtsPhase('idle');
  }, []);

  // ── Derived state ─────────────────────────────────────────────────────────

  const isAnalyzing = analysisPhase === 'preparing' || analysisPhase === 'analyzing';

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

      {/* ── Generation error ────────────────────────────────────────────── */}
      {mainPhase === 'gen-error' && (
        <div className="bg-red-900/30 border border-red-700 rounded-xl p-5 text-center">
          <AlertCircle className="w-6 h-6 text-red-400 mx-auto mb-2" />
          <p className="text-sm text-red-300 mb-4">{genError}</p>
          <button
            onClick={doGenerateText}
            className="px-5 py-2 bg-slate-700 hover:bg-slate-600 text-slate-100 text-sm rounded-lg transition-colors"
          >
            Tentar novamente
          </button>
        </div>
      )}

      {/* ── Training session ─────────────────────────────────────────────── */}
      {(mainPhase === 'ready' || mainPhase === 'results') && generatedText && (
        <>
          {/* Level + Generate new button */}
          <div className="flex items-center justify-between mb-4">
            <span className="inline-flex items-center text-xs font-medium px-2.5 py-1 rounded-full bg-blue-900/40 border border-blue-700 text-blue-300">
              Nível {userLevel ?? '—'}
            </span>
            <button
              onClick={handleGenerateNew}
              className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-100 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Gerar outro texto
            </button>
          </div>

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

          {/* Recording section */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-4">
            <h2 className="text-sm font-semibold text-slate-200 mb-3">Sua leitura</h2>

            {isAnalyzing ? (
              <div className="flex items-center gap-3 py-3">
                <Loader2 className="w-5 h-5 text-blue-400 animate-spin shrink-0" />
                <span className="text-sm text-slate-300">
                  {analysisPhase === 'preparing' ? 'Preparando análise…' : 'Analisando pronúncia…'}
                </span>
              </div>
            ) : (
              <div className="space-y-3">
                {/* Recorder state */}
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
                      aria-label={`Gravando: ${formatTime(recorder.elapsedMs)}`}
                    >
                      <span className="w-2 h-2 bg-rose-400 rounded-full animate-pulse" aria-hidden="true" />
                      {formatTime(recorder.elapsedMs)}
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

                {recorder.phase === 'done' && (
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
                      onClick={() => { playbackAudioRef.current?.pause(); setPlaybackPlaying(false); recorder.deleteRecording(); setAnalysisPhase('idle'); setAnalysisError(null); }}
                      className="flex items-center gap-2 px-3 py-2 bg-slate-700 hover:bg-slate-600 text-slate-100 text-sm rounded-lg transition-colors"
                      aria-label="Gravar novamente"
                    >
                      <RotateCcw className="w-4 h-4" /> Gravar novamente
                    </button>
                    <button
                      onClick={handleAnalyzeFull}
                      className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-500 hover:to-blue-600 text-white text-sm font-medium rounded-lg transition-all shadow-lg shadow-blue-900/30"
                      aria-label="Enviar gravação para análise de pronúncia"
                    >
                      <Send className="w-4 h-4" /> Enviar para análise
                    </button>
                  </div>
                )}

                {recorder.errorMessage && (
                  <p className="text-xs text-red-400">{recorder.errorMessage}</p>
                )}
                {analysisPhase === 'error' && analysisError && (
                  <p className="text-xs text-red-400">{analysisError}</p>
                )}
              </div>
            )}
          </div>

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

              {/* Re-record full text */}
              <div className="flex justify-center mb-6">
                <button
                  onClick={handleRerecordFull}
                  className="flex items-center gap-2 text-sm text-slate-400 hover:text-slate-100 transition-colors"
                >
                  <RotateCcw className="w-4 h-4" /> Gravar novamente o texto completo
                </button>
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
                  <div className="space-y-2">
                    {practiceWords.map(w => {
                      const cat    = wordCategories.get(w.id) ?? getWordTrainingCategory(w);
                      const colors = TRAINING_CATEGORY_COLORS[cat];
                      const lbl    = TRAINING_CATEGORY_LABELS[cat];
                      const isOpen = selectedWordId === w.id;

                      return (
                        <div key={w.id} className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
                          <button
                            onClick={() => setSelectedWordId(isOpen ? null : w.id)}
                            className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-700/50 transition-colors text-left"
                            aria-expanded={isOpen}
                            aria-label={`${isOpen ? 'Fechar' : 'Abrir'} treino da palavra ${w.displayWord}`}
                          >
                            <div className="flex items-center gap-3">
                              <span className="text-sm font-medium text-slate-100">{w.displayWord}</span>
                              <span
                                className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${colors.text} ${colors.bg} ${colors.border}`}
                              >
                                {lbl}
                              </span>
                            </div>
                            {isOpen
                              ? <ChevronUp className="w-4 h-4 text-slate-400 shrink-0" />
                              : <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
                            }
                          </button>

                          {isOpen && (
                            <div className="border-t border-slate-700 p-4">
                              <WordTrainer
                                word={w}
                                currentCategory={cat}
                                wordTtsCacheRef={wordTtsCacheRef}
                                sharedAudioRef={sharedAudioRef}
                                onAudioStart={handleWordAudioStart}
                                onCategoryUpdate={handleWordCategoryUpdate}
                                voice={audioVoice}
                                speed={speed}
                              />
                            </div>
                          )}
                        </div>
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
