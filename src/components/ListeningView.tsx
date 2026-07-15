import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Headphones, Play, Pause, RotateCcw, ChevronRight,
  Check, X, BookOpen, Clock, ArrowLeft,
  ChevronDown, ChevronUp, Trophy, AlertCircle, Star,
} from 'lucide-react';
import { LISTENING_MOCK } from '../data/listeningMock';
import type { TranscriptSegment } from '../data/listeningMock';

type MachineState =
  | 'intro'
  | 'playing'
  | 'paused'
  | 'finished'
  | 'questions'
  | 'question_result'
  | 'replay'
  | 'result'
  | 'transcript';

type TranscriptTab = 'en' | 'pt' | 'both';
type Speed = 0.75 | 1 | 1.25 | 1.5;

const SPEEDS: Speed[] = [0.75, 1, 1.25, 1.5];

const SPEAKER_COLORS: Record<string, string> = {
  Narrador: 'text-slate-400',
  Mia: 'text-purple-400',
  Jake: 'text-teal-400',
  'Mr. Harris': 'text-amber-400',
};

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function getSegment(time: number): TranscriptSegment | null {
  return LISTENING_MOCK.segments.find(seg => time >= seg.start && time < seg.end) ?? null;
}

function Waveform({ playing }: { playing: boolean }) {
  const heights = [35, 60, 80, 55, 70, 45, 85, 50, 65, 40, 75, 55, 30, 70, 85, 50, 65, 45, 80, 55, 70, 40, 60, 75, 50, 35, 65, 55];
  return (
    <>
      <style>{`@keyframes bar-wave { 0%,100%{transform:scaleY(1)} 50%{transform:scaleY(0.25)} }`}</style>
      <div className="flex items-end justify-center gap-0.5 h-16 px-2">
        {heights.map((h, i) => (
          <div
            key={i}
            style={{
              width: '5px',
              height: `${h}%`,
              background: 'rgb(168,85,247)',
              borderRadius: '3px',
              transformOrigin: 'bottom',
              animation: playing
                ? `bar-wave ${0.55 + (i % 5) * 0.13}s ease-in-out ${i * 0.035}s infinite`
                : 'none',
              opacity: playing ? 0.75 + (i % 3) * 0.08 : 0.2,
              transition: 'opacity 0.3s',
            }}
          />
        ))}
      </div>
    </>
  );
}

interface Props {
  onBack: () => void;
}

export default function ListeningView({ onBack }: Props) {
  const [ms, setMs] = useState<MachineState>('intro');
  const [time, setTime] = useState(0);
  const [speed, setSpeed] = useState<Speed>(1);
  const [qIdx, setQIdx] = useState(0);
  const [answers, setAnswers] = useState<(number | null)[]>(Array(LISTENING_MOCK.questions.length).fill(null));
  const [picked, setPicked] = useState<number | null>(null);
  const [tab, setTab] = useState<TranscriptTab>('en');
  const [rTime, setRTime] = useState(0);
  const [rPlaying, setRPlaying] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(true);

  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dur = LISTENING_MOCK.durationSeconds;

  const stopTick = useCallback(() => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
  }, []);

  useEffect(() => {
    stopTick();
    if (ms === 'playing') {
      tickRef.current = setInterval(() => {
        setTime(t => {
          const next = t + 0.1 * speed;
          if (next >= dur) { stopTick(); setMs('finished'); return dur; }
          return next;
        });
      }, 100);
    } else if (ms === 'replay' && rPlaying) {
      tickRef.current = setInterval(() => {
        setRTime(t => {
          const next = t + 0.1 * speed;
          if (next >= dur) { stopTick(); setRPlaying(false); return dur; }
          return next;
        });
      }, 100);
    }
    return stopTick;
  }, [ms, speed, rPlaying, dur, stopTick]);

  const correctCount = answers.filter((a, i) => a === LISTENING_MOCK.questions[i]?.correctIndex).length;
  const score = Math.round((correctCount / LISTENING_MOCK.questions.length) * 100);
  const seg = getSegment(time);
  const rSeg = getSegment(rTime);
  const q = LISTENING_MOCK.questions[qIdx];
  const pct = Math.min((time / dur) * 100, 100);
  const rPct = Math.min((rTime / dur) * 100, 100);
  const hasAnswers = answers.some(a => a !== null);

  function handleAnswer(idx: number) {
    setPicked(idx);
    const next = [...answers]; next[qIdx] = idx; setAnswers(next);
    setMs('question_result');
  }

  function handleNext() {
    if (qIdx + 1 >= LISTENING_MOCK.questions.length) { setMs('result'); }
    else { setQIdx(i => i + 1); setPicked(null); setMs('questions'); }
  }

  function jump(s: MachineState) {
    stopTick();
    setTime(s === 'playing' || s === 'paused' ? 30 : s === 'finished' ? dur : 0);
    setRTime(0); setRPlaying(false);
    if (s === 'questions') { setQIdx(0); setPicked(null); setAnswers(Array(5).fill(null)); }
    if (s === 'question_result') {
      setQIdx(0); setPicked(2);
      const a: (number | null)[] = Array(5).fill(null); a[0] = 2; setAnswers(a);
    }
    if (s === 'result' || s === 'transcript') { setAnswers([2, 2, 3, 3, 3]); }
    setMs(s);
  }

  // ── Intro ─────────────────────────────────────────────────────────────────

  function renderIntro() {
    return (
      <div className="p-4 pt-6 max-w-lg mx-auto">
        <div className="flex justify-center mb-6">
          <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-purple-500 to-purple-700 flex items-center justify-center shadow-lg shadow-purple-900/40">
            <Headphones className="w-10 h-10 text-white" strokeWidth={1.8} />
          </div>
        </div>

        <h1 className="text-2xl font-bold text-slate-100 text-center mb-1">
          {LISTENING_MOCK.titleEn}
        </h1>
        <p className="text-sm text-purple-400 text-center mb-5">{LISTENING_MOCK.titlePt}</p>

        <div className="flex items-center justify-center gap-3 mb-4 flex-wrap">
          <span className="px-2.5 py-1 rounded-full bg-purple-600/20 border border-purple-500/30 text-xs font-semibold text-purple-300">
            {LISTENING_MOCK.level}
          </span>
          <span className="flex items-center gap-1 text-xs text-slate-400">
            <Clock className="w-3.5 h-3.5" />
            {fmt(LISTENING_MOCK.durationSeconds)}
          </span>
          <span className="flex items-center gap-1 text-xs text-slate-400">
            <BookOpen className="w-3.5 h-3.5" />
            {LISTENING_MOCK.questions.length} perguntas
          </span>
        </div>

        <div className="flex gap-2 flex-wrap justify-center mb-6">
          {LISTENING_MOCK.tags.map(t => (
            <span key={t} className="text-xs px-2 py-0.5 rounded bg-slate-700 text-slate-400">{t}</span>
          ))}
        </div>

        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-8">
          <p className="text-sm text-slate-300 leading-relaxed">{LISTENING_MOCK.descriptionPt}</p>
        </div>

        <button
          onClick={() => { setTime(0); setMs('playing'); }}
          className="w-full py-4 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold transition-colors flex items-center justify-center gap-2"
        >
          <Play className="w-5 h-5" />
          Começar a ouvir
        </button>

        <button
          onClick={() => setMs('transcript')}
          className="w-full mt-3 py-3 text-sm text-purple-400 hover:text-purple-300 transition-colors"
        >
          Ver transcrição completa
        </button>
      </div>
    );
  }

  // ── Player (playing / paused) ─────────────────────────────────────────────

  function renderPlayer() {
    const isPlaying = ms === 'playing';
    return (
      <div className="p-4 pt-2 max-w-lg mx-auto">
        <div className="text-center mb-4">
          <h2 className="text-base font-semibold text-slate-100">{LISTENING_MOCK.titleEn}</h2>
          <p className="text-xs text-purple-400 mt-0.5">{LISTENING_MOCK.titlePt}</p>
        </div>

        <div className="bg-slate-800 border border-slate-700 rounded-2xl py-5 px-4 mb-4">
          <Waveform playing={isPlaying} />

          <div className="mt-4">
            <div className="flex justify-between text-xs text-slate-500 mb-1.5">
              <span>{fmt(time)}</span>
              <span>{fmt(dur)}</span>
            </div>
            <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-purple-500 rounded-full transition-all duration-100"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>

          {seg && (
            <div className="mt-4 pt-4 border-t border-slate-700">
              <span className={`text-xs font-semibold ${SPEAKER_COLORS[seg.speaker] ?? 'text-slate-400'}`}>
                {seg.speaker}
              </span>
              <p className="text-sm text-slate-200 mt-1 leading-relaxed italic">
                "{seg.textEn}"
              </p>
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="flex items-center justify-center gap-4 mb-5">
          <button
            onClick={() => { stopTick(); setTime(0); setMs('playing'); }}
            className="p-3 rounded-full bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors"
            title="Reiniciar"
          >
            <RotateCcw className="w-5 h-5" />
          </button>
          <button
            onClick={() => setMs(isPlaying ? 'paused' : 'playing')}
            className="p-5 rounded-full bg-purple-600 hover:bg-purple-500 text-white transition-colors shadow-lg shadow-purple-900/40"
          >
            {isPlaying ? <Pause className="w-7 h-7" /> : <Play className="w-7 h-7" />}
          </button>
          <button
            onClick={() => { stopTick(); setTime(dur); setMs('finished'); }}
            className="p-3 rounded-full bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors"
            title="Pular para o fim"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>

        {/* Speed */}
        <div className="flex items-center justify-center gap-2">
          {SPEEDS.map(s => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                speed === s ? 'bg-purple-600 text-white' : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
              }`}
            >
              {s === 1 ? '1×' : `${s}×`}
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ── Finished ──────────────────────────────────────────────────────────────

  function renderFinished() {
    return (
      <div className="p-4 pt-8 max-w-lg mx-auto text-center">
        <div className="w-16 h-16 rounded-full bg-purple-600/20 border border-purple-500/30 flex items-center justify-center mx-auto mb-5">
          <Check className="w-8 h-8 text-purple-400" />
        </div>
        <h2 className="text-xl font-bold text-slate-100 mb-2">Você chegou ao fim!</h2>
        <p className="text-sm text-slate-400 mb-8">
          Você ouviu "{LISTENING_MOCK.titleEn}" completo. Agora teste sua compreensão.
        </p>

        <button
          onClick={() => { setQIdx(0); setAnswers(Array(5).fill(null)); setPicked(null); setMs('questions'); }}
          className="w-full py-4 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold transition-colors flex items-center justify-center gap-2 mb-3"
        >
          Responder as perguntas
          <ChevronRight className="w-5 h-5" />
        </button>

        <button
          onClick={() => { setTime(0); setMs('playing'); }}
          className="w-full py-3 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm font-medium transition-colors"
        >
          Ouvir novamente
        </button>
      </div>
    );
  }

  // ── Questions ─────────────────────────────────────────────────────────────

  function renderQuestions() {
    return (
      <div className="p-4 pt-4 max-w-lg mx-auto">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-purple-400 font-medium">
            Pergunta {qIdx + 1} de {LISTENING_MOCK.questions.length}
          </span>
          <span className="text-xs text-slate-500">{LISTENING_MOCK.level}</span>
        </div>
        <div className="h-1 bg-slate-700 rounded-full mb-6 overflow-hidden">
          <div
            className="h-full bg-purple-500 rounded-full transition-all"
            style={{ width: `${(qIdx / LISTENING_MOCK.questions.length) * 100}%` }}
          />
        </div>

        <h3 className="text-lg font-semibold text-slate-100 leading-snug mb-6">{q.textEn}</h3>

        <div className="space-y-3">
          {q.options.map((opt, i) => (
            <button
              key={i}
              onClick={() => handleAnswer(i)}
              className="w-full text-left px-4 py-3.5 rounded-xl bg-slate-800 border border-slate-700 hover:border-purple-500 hover:bg-slate-700/60 text-sm text-slate-200 transition-all"
            >
              <span className="font-semibold text-purple-400 mr-2">{String.fromCharCode(65 + i)}.</span>
              {opt}
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ── Question result ───────────────────────────────────────────────────────

  function renderQuestionResult() {
    const isCorrect = picked === q.correctIndex;
    return (
      <div className="p-4 pt-4 max-w-lg mx-auto">
        <div className={`flex items-center gap-3 p-4 rounded-xl mb-5 ${
          isCorrect ? 'bg-emerald-900/40 border border-emerald-700/50' : 'bg-red-900/40 border border-red-700/50'
        }`}>
          {isCorrect
            ? <Check className="w-6 h-6 text-emerald-400 shrink-0" />
            : <X className="w-6 h-6 text-red-400 shrink-0" />
          }
          <div>
            <p className={`font-semibold text-sm ${isCorrect ? 'text-emerald-300' : 'text-red-300'}`}>
              {isCorrect ? 'Correto!' : 'Incorreto'}
            </p>
            {!isCorrect && (
              <p className="text-xs text-slate-400 mt-0.5">
                Correta: {String.fromCharCode(65 + q.correctIndex)}. {q.options[q.correctIndex]}
              </p>
            )}
          </div>
        </div>

        <h3 className="text-base font-semibold text-slate-200 mb-4">{q.textEn}</h3>

        <div className="space-y-2 mb-5">
          {q.options.map((opt, i) => {
            const isSelected = i === picked;
            const isCorrectOpt = i === q.correctIndex;
            let cls = 'bg-slate-800 border-slate-700 text-slate-500';
            if (isCorrectOpt) cls = 'bg-emerald-900/30 border-emerald-600/50 text-emerald-200';
            else if (isSelected && !isCorrect) cls = 'bg-red-900/30 border-red-600/50 text-red-200';
            return (
              <div key={i} className={`flex items-start gap-3 px-4 py-3 rounded-xl border text-sm ${cls}`}>
                <span className="font-semibold shrink-0">{String.fromCharCode(65 + i)}.</span>
                <span className="flex-1">{opt}</span>
                {isCorrectOpt && <Check className="w-4 h-4 ml-auto shrink-0 text-emerald-400 mt-0.5" />}
                {isSelected && !isCorrect && <X className="w-4 h-4 ml-auto shrink-0 text-red-400 mt-0.5" />}
              </div>
            );
          })}
        </div>

        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-6">
          <p className="text-xs text-slate-500 font-medium mb-1">Explicação</p>
          <p className="text-sm text-slate-300 leading-relaxed">{q.explanationPt}</p>
        </div>

        <button
          onClick={handleNext}
          className="w-full py-4 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold transition-colors flex items-center justify-center gap-2"
        >
          {qIdx + 1 >= LISTENING_MOCK.questions.length ? 'Ver resultado' : 'Próxima pergunta'}
          <ChevronRight className="w-5 h-5" />
        </button>
      </div>
    );
  }

  // ── Result ────────────────────────────────────────────────────────────────

  function renderResult() {
    const isPerfect = score >= 90;
    const isGood = score >= 60;
    const ringColor = isPerfect ? 'border-amber-400' : isGood ? 'border-teal-400' : 'border-red-400';
    const textColor = isPerfect ? 'text-amber-300' : isGood ? 'text-teal-300' : 'text-red-300';
    const message = isPerfect
      ? 'Excelente! Você entendeu tudo!'
      : isGood
      ? 'Bom trabalho! Continue praticando.'
      : 'Precisa de mais prática. Não desanime!';

    return (
      <div className="p-4 pt-6 max-w-lg mx-auto">
        <div className="flex justify-center mb-5">
          <div className={`w-28 h-28 rounded-full border-4 ${ringColor} flex flex-col items-center justify-center`}>
            <span className={`text-3xl font-bold ${textColor}`}>{score}%</span>
            <span className="text-xs text-slate-500 mt-0.5">{correctCount}/{LISTENING_MOCK.questions.length}</span>
          </div>
        </div>

        <div className="text-center mb-6">
          {isPerfect && <Trophy className="w-8 h-8 text-amber-400 mx-auto mb-2" />}
          {isGood && !isPerfect && <Star className="w-8 h-8 text-teal-400 mx-auto mb-2" />}
          {!isGood && <AlertCircle className="w-8 h-8 text-red-400 mx-auto mb-2" />}
          <p className={`font-semibold text-base ${textColor}`}>{message}</p>
        </div>

        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-6">
          <p className="text-xs text-slate-500 font-medium mb-3">Suas respostas</p>
          <div className="space-y-2">
            {LISTENING_MOCK.questions.map((question, i) => {
              const wasCorrect = answers[i] === question.correctIndex;
              return (
                <div key={i} className="flex items-center gap-3 text-sm">
                  {wasCorrect
                    ? <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                    : <X className="w-4 h-4 text-red-400 shrink-0" />
                  }
                  <span className="text-slate-400 flex-1 line-clamp-1">{question.textEn}</span>
                </div>
              );
            })}
          </div>
        </div>

        <button
          onClick={() => { setRTime(0); setRPlaying(false); setMs('replay'); }}
          className="w-full py-3.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold text-sm transition-colors mb-3 flex items-center justify-center gap-2"
        >
          <Headphones className="w-4 h-4" />
          Reouvir com legendas
        </button>
        <button
          onClick={() => setMs('transcript')}
          className="w-full py-3.5 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm font-medium transition-colors mb-3 flex items-center justify-center gap-2"
        >
          <BookOpen className="w-4 h-4" />
          Ver transcrição completa
        </button>
        <button
          onClick={() => { stopTick(); setTime(0); setQIdx(0); setAnswers(Array(5).fill(null)); setMs('intro'); }}
          className="w-full py-3 text-sm text-slate-500 hover:text-slate-400 transition-colors"
        >
          Recomeçar do início
        </button>
      </div>
    );
  }

  // ── Replay ────────────────────────────────────────────────────────────────

  function renderReplay() {
    return (
      <div className="p-4 pt-2 max-w-lg mx-auto">
        <div className="text-center mb-4">
          <h2 className="text-base font-semibold text-slate-100">Replay com legendas</h2>
          <p className="text-xs text-slate-500 mt-0.5">Acompanhe o texto em inglês enquanto ouve</p>
        </div>

        <div className="bg-slate-800 border border-slate-700 rounded-2xl p-5 mb-4 min-h-[120px] flex flex-col justify-center">
          {rSeg ? (
            <>
              <span className={`text-xs font-semibold mb-2 ${SPEAKER_COLORS[rSeg.speaker] ?? 'text-slate-400'}`}>
                {rSeg.speaker}
              </span>
              <p className="text-base text-slate-100 leading-relaxed italic">"{rSeg.textEn}"</p>
            </>
          ) : (
            <p className="text-sm text-slate-600 text-center">
              {rPlaying ? 'Aguardando...' : 'Pressione play para começar'}
            </p>
          )}
        </div>

        <div className="mb-4">
          <div className="flex justify-between text-xs text-slate-500 mb-1.5">
            <span>{fmt(rTime)}</span>
            <span>{fmt(dur)}</span>
          </div>
          <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-purple-500 rounded-full transition-all duration-100"
              style={{ width: `${rPct}%` }}
            />
          </div>
        </div>

        <div className="flex items-center justify-center gap-4 mb-5">
          <button
            onClick={() => { setRTime(0); setRPlaying(false); }}
            className="p-3 rounded-full bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors"
            title="Reiniciar"
          >
            <RotateCcw className="w-5 h-5" />
          </button>
          <button
            onClick={() => setRPlaying(p => !p)}
            className="p-5 rounded-full bg-purple-600 hover:bg-purple-500 text-white transition-colors shadow-lg shadow-purple-900/40"
          >
            {rPlaying ? <Pause className="w-7 h-7" /> : <Play className="w-7 h-7" />}
          </button>
          <button
            onClick={() => setMs('result')}
            className="p-3 rounded-full bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors"
            title="Ver resultado"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>

        <div className="flex items-center justify-center gap-2 mb-6">
          {SPEEDS.map(s => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                speed === s ? 'bg-purple-600 text-white' : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
              }`}
            >
              {s === 1 ? '1×' : `${s}×`}
            </button>
          ))}
        </div>

        <button
          onClick={() => setMs('result')}
          className="w-full py-3 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm font-medium transition-colors"
        >
          Ir para resultado
        </button>
      </div>
    );
  }

  // ── Transcript ────────────────────────────────────────────────────────────

  function renderTranscript() {
    return (
      <div className="p-4 pt-2 max-w-lg mx-auto">
        <h2 className="text-lg font-semibold text-slate-100 mb-4">Transcrição</h2>

        <div className="flex rounded-xl bg-slate-800 p-1 mb-5">
          {(['en', 'pt', 'both'] as TranscriptTab[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
                tab === t ? 'bg-purple-600 text-white' : 'text-slate-400 hover:text-slate-300'
              }`}
            >
              {t === 'en' ? 'Inglês' : t === 'pt' ? 'Português' : 'Ambos'}
            </button>
          ))}
        </div>

        <div className="space-y-3 mb-6">
          {LISTENING_MOCK.segments.map(segment => (
            <div key={segment.id} className="bg-slate-800 border border-slate-700/50 rounded-xl p-4">
              <span className={`text-xs font-semibold block mb-2 ${SPEAKER_COLORS[segment.speaker] ?? 'text-slate-400'}`}>
                {segment.speaker}
                <span className="text-slate-600 font-normal ml-2">
                  {fmt(segment.start)}–{fmt(segment.end)}
                </span>
              </span>
              {(tab === 'en' || tab === 'both') && (
                <p className="text-sm text-slate-200 leading-relaxed italic">
                  "{segment.textEn}"
                </p>
              )}
              {(tab === 'pt' || tab === 'both') && (
                <p className={`text-sm text-slate-400 leading-relaxed ${tab === 'both' ? 'mt-2 pt-2 border-t border-slate-700/40' : ''}`}>
                  {segment.textPt}
                </p>
              )}
            </div>
          ))}
        </div>

        <button
          onClick={() => setMs(hasAnswers ? 'result' : 'intro')}
          className="w-full py-3 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm font-medium transition-colors"
        >
          {hasAnswers ? 'Voltar ao resultado' : 'Voltar'}
        </button>
      </div>
    );
  }

  // ── Preview controls ──────────────────────────────────────────────────────

  const PREVIEW_STATES: { id: MachineState; label: string }[] = [
    { id: 'intro', label: 'Intro' },
    { id: 'playing', label: 'Playing' },
    { id: 'paused', label: 'Paused' },
    { id: 'finished', label: 'Finished' },
    { id: 'questions', label: 'Questions' },
    { id: 'question_result', label: 'Q.Result' },
    { id: 'replay', label: 'Replay' },
    { id: 'result', label: 'Result' },
    { id: 'transcript', label: 'Transcript' },
  ];

  function renderPreviewControls() {
    return (
      <div className="fixed bottom-0 left-0 right-0 z-50 bg-slate-950 border-t border-amber-700/40">
        <button
          onClick={() => setPreviewOpen(p => !p)}
          className="w-full flex items-center justify-center gap-2 py-2 text-xs text-amber-500/70 hover:text-amber-400 transition-colors"
        >
          {previewOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
          <span>Preview Controls</span>
          {previewOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
        </button>
        {previewOpen && (
          <div className="px-3 pb-3 grid grid-cols-3 sm:grid-cols-5 gap-1.5">
            {PREVIEW_STATES.map(s => (
              <button
                key={s.id}
                onClick={() => jump(s.id)}
                className={`py-2 rounded-lg text-xs font-medium transition-colors ${
                  ms === s.id
                    ? 'bg-amber-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Main render ───────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 pb-48">
      {/* Mini-header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-800 sticky top-0 bg-slate-900/95 backdrop-blur z-10">
        <button
          onClick={ms === 'intro' ? onBack : () => setMs('intro')}
          className="p-2 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Headphones className="w-4 h-4 text-purple-400 shrink-0" />
          <span className="text-sm font-medium text-slate-300 truncate">
            {ms === 'intro' ? 'Listening' : LISTENING_MOCK.titleEn}
          </span>
        </div>
        <span className="text-xs text-purple-400 font-medium shrink-0">{LISTENING_MOCK.level}</span>
      </div>

      {/* Content */}
      {ms === 'intro' && renderIntro()}
      {(ms === 'playing' || ms === 'paused') && renderPlayer()}
      {ms === 'finished' && renderFinished()}
      {ms === 'questions' && renderQuestions()}
      {ms === 'question_result' && renderQuestionResult()}
      {ms === 'replay' && renderReplay()}
      {ms === 'result' && renderResult()}
      {ms === 'transcript' && renderTranscript()}

      {renderPreviewControls()}
    </div>
  );
}
