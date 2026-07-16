import { useState, useCallback, useId, useRef, useEffect, MutableRefObject } from 'react';
import type { PronunciationWordDetail } from '../lib/pronunciationWordParser';
import { getWordBand, selectWorstWords, WORD_BANDS, buildWordAlignment } from '../lib/pronunciationWordParser';
import PronunciationWordDetailPanel from './PronunciationWordDetailPanel';
import { Volume2, Mic, Square, Pause, Loader2, CheckCircle } from 'lucide-react';
import { useAudioRecorder } from '../hooks/useAudioRecorder';
import { getAuthHeader } from '../lib/apiAuth';
import { convertToWavPcm, AudioConversionError } from '../lib/audioConverter';
import { createRecognitionSession, PronunciationServiceError } from '../lib/pronunciationService';
import { DEFAULT_AUDIO_SETTINGS, fetchAudioSettings } from '../lib/audioSettings';
import type { PronunciationNormalizedResult } from '../types';

interface Props {
  aligned: PronunciationWordDetail[];
  insertions: PronunciationWordDetail[];
}

export default function PronunciationWordGrid({ aligned, insertions }: Props) {
  const [selectedWord, setSelectedWord] = useState<PronunciationWordDetail | null>(null);
  const [returnFocusId, setReturnFocusId] = useState<string | null>(null);
  const [activeRecordingWordId, setActiveRecordingWordId] = useState<string | null>(null);
  const [voice, setVoice] = useState<string>(DEFAULT_AUDIO_SETTINGS.voice);

  useEffect(() => {
    fetchAudioSettings().then(s => setVoice(s.voice)).catch(() => {});
  }, []);
  const legendId = useId();

  const sharedAudioRef = useRef<HTMLAudioElement | null>(null);
  const wordTtsCacheRef = useRef<Map<string, string>>(new Map());

  const handleSelectWord = useCallback((word: PronunciationWordDetail) => {
    setReturnFocusId(word.id);
    setSelectedWord(word);
  }, []);

  const handleClose = useCallback(() => {
    setSelectedWord(null);
  }, []);

  const handleAudioStart = useCallback(() => {
    if (sharedAudioRef.current && !sharedAudioRef.current.paused) {
      sharedAudioRef.current.pause();
    }
  }, []);

  const worstWords = selectWorstWords(aligned);
  const hasInsertions = insertions.length > 0;
  const hasWorstSection = worstWords.length > 0;

  return (
    <>
      <div className="space-y-4">
        {/* Header */}
        <div>
          <p className="text-xs text-slate-500 font-medium uppercase tracking-wider mb-1">
            Resultado por palavra
          </p>
          <p className="text-xs text-slate-600">
            Toque em uma palavra para ver os detalhes da pronúncia.
          </p>
        </div>

        {/* Legend */}
        <Legend id={legendId} />

        {/* Word flow */}
        <div
          className="flex flex-wrap gap-1.5"
          role="group"
          aria-label="Palavras do texto com resultado de pronúncia"
          aria-describedby={legendId}
        >
          {aligned.map((word) => (
            <WordButton
              key={word.id}
              word={word}
              onClick={handleSelectWord}
            />
          ))}
        </div>

        {/* Worst words to practice */}
        {hasWorstSection && (
          <div className="space-y-2">
            <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">
              Palavras para praticar
            </p>
            <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl divide-y divide-slate-700/50 overflow-hidden">
              {worstWords.map((word) => (
                <PracticeWordRow
                  key={`worst-${word.id}`}
                  word={word}
                  wordTtsCacheRef={wordTtsCacheRef}
                  sharedAudioRef={sharedAudioRef}
                  activeRecordingWordId={activeRecordingWordId}
                  onRecordingChange={setActiveRecordingWordId}
                  onAudioStart={handleAudioStart}
                  voice={voice}
                />
              ))}
            </div>
          </div>
        )}

        {/* Insertions */}
        {hasInsertions && (
          <div className="space-y-2">
            <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">
              Palavras adicionais identificadas
            </p>
            <p className="text-[10px] text-slate-600">
              O Azure identificou estas palavras, mas elas não fazem parte do texto de referência.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {insertions.map((word) => (
                <WordButton
                  key={word.id}
                  word={word}
                  onClick={handleSelectWord}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Detail panel (portal-like overlay) */}
      <PronunciationWordDetailPanel
        word={selectedWord}
        returnFocusId={returnFocusId}
        onClose={handleClose}
      />
    </>
  );
}

// ── Practice word row ─────────────────────────────────────────────────────────

interface PracticeWordRowProps {
  word: PronunciationWordDetail;
  wordTtsCacheRef: MutableRefObject<Map<string, string>>;
  sharedAudioRef: MutableRefObject<HTMLAudioElement | null>;
  activeRecordingWordId: string | null;
  onRecordingChange: (wordId: string | null) => void;
  onAudioStart: () => void;
  voice: string;
}

function PracticeWordRow({
  word,
  wordTtsCacheRef,
  sharedAudioRef,
  activeRecordingWordId,
  onRecordingChange,
  onAudioStart,
  voice,
}: PracticeWordRowProps) {
  const [band, setBand] = useState(getWordBand(word));
  const [ttsPhase, setTtsPhase] = useState<'idle' | 'loading' | 'playing'>('idle');
  const [analysisState, setAnalysisState] = useState<'idle' | 'analyzing' | 'done' | 'error'>('idle');
  const [justGood, setJustGood] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const recorder = useAudioRecorder();
  const mountedRef = useRef(true);
  const myAudioRef = useRef<HTMLAudioElement | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const submittedRef = useRef(false);

  const cleanWord = word.displayWord.replace(/^[^a-zA-Z0-9''-]+|[^a-zA-Z0-9''-]+$/g, '').trim();
  const ttsKey = cleanWord.toLowerCase();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelRef.current?.();
      myAudioRef.current?.pause();
    };
  }, []);

  // Auto-submit as soon as recording blob is ready
  useEffect(() => {
    if (recorder.phase === 'done' && recorder.audioBlob && !submittedRef.current) {
      submittedRef.current = true;
      runAnalysis(recorder.audioBlob, recorder.durationMs);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder.phase, recorder.audioBlob]);

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
        const headers = await getAuthHeader();
        const resp = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ text: cleanWord, voice }),
        });
        if (!resp.ok) throw new Error('TTS_FAILED');
        const blob = await resp.blob();
        url = URL.createObjectURL(blob);
        if (!mountedRef.current) { URL.revokeObjectURL(url); return; }
        wordTtsCacheRef.current.set(ttsKey, url);
      } catch {
        if (mountedRef.current) setTtsPhase('idle');
        return;
      }
    }

    const audio = new Audio(url);
    audio.playbackRate = 1;
    myAudioRef.current = audio;
    sharedAudioRef.current = audio;
    audio.onended = () => { if (mountedRef.current) setTtsPhase('idle'); };
    audio.onerror = () => { if (mountedRef.current) setTtsPhase('idle'); };
    setTtsPhase('playing');
    audio.play().catch(() => { if (mountedRef.current) setTtsPhase('idle'); });
  }

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

  async function runAnalysis(audioBlob: Blob, audioDurationMs: number) {
    if (!mountedRef.current) return;
    setAnalysisState('analyzing');
    onRecordingChange(null);

    try {
      const headers = await getAuthHeader();
      const tokenResp = await fetch('/api/pronunciation-training/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
      });
      if (!tokenResp.ok) throw new Error('Token unavailable');
      const { token, region } = await tokenResp.json() as { token: string; region: string };

      const wavFile = await convertToWavPcm(audioBlob);
      const session = createRecognitionSession({ token, region, referenceText: cleanWord, wavFile, audioDurationMs });
      cancelRef.current = session.cancel;
      const result: PronunciationNormalizedResult = await session.run();
      cancelRef.current = null;
      if (!mountedRef.current) return;

      const { aligned: newAligned } = buildWordAlignment(cleanWord, result.rawSegments);
      const newBand = newAligned.length > 0 ? getWordBand(newAligned[0]) : getWordBand(word);
      setBand(newBand);

      if (newBand.band === 'good') {
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

      let msg = 'Erro. Tente novamente.';
      if (err instanceof PronunciationServiceError) {
        if (err.code === 'AZURE_NO_MATCH') msg = 'Nenhuma fala detectada.';
        else if (err.code === 'AZURE_TIMEOUT') msg = 'Análise demorou.';
      } else if (err instanceof AudioConversionError) {
        msg = 'Áudio inválido.';
      }
      setErrorMsg(msg);
      setAnalysisState('error');
    }
  }

  const isRecording = recorder.phase === 'recording' || recorder.phase === 'requesting';
  const isAnalyzing = analysisState === 'analyzing';
  const otherActive = activeRecordingWordId !== null && activeRecordingWordId !== word.id;
  const micDisabled = isAnalyzing || otherActive;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 min-h-[52px]">
      <span
        className="flex-1 min-w-0 text-sm font-medium text-slate-100 truncate"
        title={word.displayWord}
      >
        {word.displayWord}
      </span>

      <span
        className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-full border whitespace-nowrap transition-all ${band.colorClass} ${band.bgClass} ${band.borderClass} ${justGood ? 'ring-1 ring-offset-1 ring-offset-slate-800 ring-green-500' : ''}`}
        aria-label={`Classificação: ${band.label}`}
      >
        {band.label}
      </span>

      <button
        onClick={handlePlayWord}
        disabled={ttsPhase === 'loading' || isAnalyzing}
        className={`shrink-0 w-11 h-11 flex items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 disabled:cursor-not-allowed ${
          ttsPhase === 'playing'
            ? 'bg-blue-600 text-white'
            : 'bg-slate-700 hover:bg-slate-600 text-slate-300 hover:text-slate-100'
        }`}
        aria-label={ttsPhase === 'playing' ? `Parar áudio de ${word.displayWord}` : `Ouvir pronúncia de ${word.displayWord}`}
      >
        {ttsPhase === 'loading'
          ? <Loader2 className="w-4 h-4 animate-spin" />
          : ttsPhase === 'playing'
            ? <Pause className="w-4 h-4" />
            : <Volume2 className="w-4 h-4" />
        }
      </button>

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
          aria-label={isRecording ? `Parar gravação de ${word.displayWord}` : `Gravar pronúncia de ${word.displayWord}`}
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

// ── Word button ───────────────────────────────────────────────────────────────

interface WordButtonProps {
  word: PronunciationWordDetail;
  onClick: (word: PronunciationWordDetail) => void;
}

function WordButton({ word, onClick }: WordButtonProps) {
  const band = getWordBand(word);
  const ariaLabel = band.makeAriaLabel(word.displayWord, word.accuracyScore);

  return (
    <button
      id={word.id}
      type="button"
      onClick={() => onClick(word)}
      className={`
        px-2 py-1 rounded border text-sm leading-snug
        transition-opacity
        hover:opacity-80 active:opacity-60
        focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-offset-slate-900 focus:ring-blue-500
        min-h-[36px] min-w-[36px]
        ${band.bgClass} ${band.borderClass} ${band.colorClass}
      `}
      aria-label={ariaLabel}
    >
      {word.displayWord}
    </button>
  );
}

// ── Legend ────────────────────────────────────────────────────────────────────

function Legend({ id }: { id: string }) {
  const items: Array<{ band: ReturnType<typeof getWordBand>; text: string }> = [
    { band: WORD_BANDS.good,      text: 'Boa' },
    { band: WORD_BANDS.attention, text: 'Pode melhorar' },
    { band: WORD_BANDS.practice,  text: 'Pratique' },
    { band: WORD_BANDS.omission,  text: 'Não identificada' },
  ];

  return (
    <div
      id={id}
      className="flex flex-wrap gap-x-4 gap-y-1.5"
      aria-label="Legenda das cores de pronúncia"
      role="note"
    >
      {items.map((item) => (
        <div key={item.band.band} className="flex items-center gap-1.5">
          <span
            className={`inline-block w-2.5 h-2.5 rounded-sm border ${item.band.bgClass} ${item.band.borderClass}`}
            aria-hidden="true"
          />
          <span className={`text-[10px] ${item.band.colorClass}`}>{item.text}</span>
        </div>
      ))}
    </div>
  );
}
