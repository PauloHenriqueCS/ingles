import { useState, useEffect } from 'react';
import { DayEntry, Difficulty, Status, AIFeedback, VocabularyItem } from '../types';
import { getScheduleForDate } from '../data/calendar2026';
import { countWords } from '../utils/wordCount';

interface Props {
  date: string;
  entry: DayEntry | null;
  onSave: (patch: Partial<DayEntry> & { date: string }) => Promise<void>;
  onBack: () => void;
}

const DIFF_OPTS: { value: Difficulty; label: string; cls: string }[] = [
  { value: 'facil', label: 'Fácil', cls: 'bg-green-700 text-green-100' },
  { value: 'medio', label: 'Médio', cls: 'bg-amber-700 text-amber-100' },
  { value: 'dificil', label: 'Difícil', cls: 'bg-red-700 text-red-100' },
];

type ReviewState = 'idle' | 'loading' | 'done' | 'error';
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export default function DayView({ date, entry, onSave, onBack }: Props) {
  const schedule = getScheduleForDate(date);

  const [title, setTitle] = useState(entry?.title ?? '');
  const [originalText, setOriginalText] = useState(entry?.originalText ?? '');
  const [difficulty, setDifficulty] = useState<Difficulty>(entry?.difficulty ?? null);
  const [status, setStatus] = useState<Status>(entry?.status ?? 'nao-iniciado');
  const [aiReview, setAiReview] = useState<AIFeedback | null>(entry?.aiReview ?? null);
  const [reviewState, setReviewState] = useState<ReviewState>(entry?.aiReview ? 'done' : 'idle');
  const [saveState, setSaveState] = useState<SaveState>('idle');

  useEffect(() => {
    setTitle(entry?.title ?? '');
    setOriginalText(entry?.originalText ?? '');
    setDifficulty(entry?.difficulty ?? null);
    setStatus(entry?.status ?? 'nao-iniciado');
    setAiReview(entry?.aiReview ?? null);
    setReviewState(entry?.aiReview ? 'done' : 'idle');
    setSaveState('idle');
  }, [date, entry]);

  async function handleSaveDraft() {
    const finalStatus: Status =
      status === 'nao-iniciado' && originalText.trim().length > 0 ? 'escrito' : status;
    setSaveState('saving');
    try {
      await onSave({
        date, title, originalText,
        correctedText: aiReview?.correctedText ?? entry?.correctedText ?? '',
        observations: entry?.observations ?? '',
        mainErrors: aiReview ? aiReview.mainErrors.join('\n') : (entry?.mainErrors ?? ''),
        difficulty, status: finalStatus, aiReview,
      });
      setStatus(finalStatus);
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 2000);
    } catch {
      setSaveState('error');
      setTimeout(() => setSaveState('idle'), 3000);
    }
  }

  async function handleReview() {
    if (!originalText.trim()) return;
    setReviewState('loading');
    try {
      const res = await fetch('/api/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: originalText,
          theme: schedule?.theme ?? '',
          verbTense: schedule?.verbTense ?? '',
          grammarObjective: schedule?.grammarObjective ?? '',
          level: schedule?.level ?? 'B1',
        }),
      });
      if (!res.ok) throw new Error('Review failed');
      const { feedback } = await res.json() as { feedback: AIFeedback };
      setAiReview(feedback);
      setReviewState('done');
      await onSave({
        date, title, originalText,
        correctedText: feedback.correctedText,
        observations: entry?.observations ?? '',
        mainErrors: feedback.mainErrors.join('\n'),
        difficulty, status: 'corrigido', aiReview: feedback,
      });
      setStatus('corrigido');
    } catch {
      setReviewState('error');
      setTimeout(() => setReviewState('idle'), 4000);
    }
  }

  const words = countWords(originalText);
  const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('pt-BR', {
    weekday: 'long', day: 'numeric', month: 'long',
  });

  const isReviewing = reviewState === 'loading';

  const saveBtnCls =
    saveState === 'saved' ? 'bg-green-700 text-white' :
    saveState === 'error' ? 'bg-red-800 text-white' :
    saveState === 'saving' ? 'bg-slate-700 text-slate-400' :
    'bg-slate-700 hover:bg-slate-600 text-slate-200';

  const saveBtnLabel =
    saveState === 'saving' ? 'Salvando...' :
    saveState === 'saved' ? '✓ Salvo!' :
    saveState === 'error' ? 'Erro' :
    'Salvar rascunho';

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      <header className="sticky top-0 bg-slate-800 border-b border-slate-700 px-4 py-3 flex items-center gap-3 z-10">
        <button onClick={onBack} className="text-slate-400 hover:text-slate-100 text-lg">←</button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-100 capitalize truncate">{dateLabel}</p>
          <p className="text-xs text-slate-400 truncate">{schedule?.theme ?? '—'}</p>
        </div>
        <StatusBadgePill status={status} />
      </header>

      <div className="flex-1 overflow-auto p-4 max-w-lg mx-auto w-full space-y-4 pb-10">
        {schedule && !schedule.isWeekend && (
          <div className="bg-slate-800 rounded-xl p-4 space-y-2">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              {schedule.level && (
                <span className="px-2 py-0.5 rounded bg-blue-900 text-blue-300 text-xs font-bold">
                  {schedule.level}
                </span>
              )}
              {schedule.estimatedTime && (
                <span className="text-xs text-slate-500">⏱ {schedule.estimatedTime} min</span>
              )}
            </div>
            <InfoRow label="Tempo verbal" value={schedule.verbTense} />
            <InfoRow label="Objetivo" value={schedule.grammarObjective} />
          </div>
        )}

        {schedule?.isWeekend && (
          <div className="bg-slate-800 rounded-xl p-4 text-center text-slate-400">
            <p className="text-2xl mb-2">{schedule.weekendActivity === 'descanso' ? '😴' : '📖'}</p>
            <p className="font-medium text-slate-300">{schedule.theme}</p>
            <p className="text-sm mt-1">{schedule.grammarObjective}</p>
          </div>
        )}

        <div>
          <label className="text-xs text-slate-400 mb-2 block">Título</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Ex: My Morning Routine"
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-slate-100 placeholder-slate-600 text-sm focus:outline-none focus:border-blue-500"
          />
        </div>

        <div>
          <div className="flex justify-between mb-2">
            <label className="text-xs text-slate-400">Seu texto</label>
            <span className="text-xs text-slate-500">{words} palavras</span>
          </div>
          <textarea
            value={originalText}
            onChange={(e) => setOriginalText(e.target.value)}
            placeholder="Escreva seu texto em inglês aqui..."
            className="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-slate-100 placeholder-slate-600 text-sm focus:outline-none focus:border-blue-500 min-h-[200px] resize-none"
          />
        </div>

        <div>
          <label className="text-xs text-slate-400 mb-2 block">Dificuldade</label>
          <div className="flex gap-2">
            {DIFF_OPTS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setDifficulty(difficulty === opt.value ? null : opt.value)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-opacity ${opt.cls} ${
                  difficulty === opt.value ? 'opacity-100 ring-2 ring-white/30' : 'opacity-40'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-3">
          <button
            onClick={handleSaveDraft}
            disabled={saveState === 'saving'}
            className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors ${saveBtnCls}`}
          >
            {saveBtnLabel}
          </button>
          <button
            onClick={handleReview}
            disabled={!originalText.trim() || reviewState === 'loading'}
            className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {reviewState === 'loading' ? '⏳ Analisando...' : '🤖 Revisar com IA'}
          </button>
        </div>

        {reviewState === 'loading' && (
          <div className="bg-slate-800 rounded-xl p-8 text-center space-y-3">
            <p className="text-3xl">🧠</p>
            <p className="text-slate-200 font-medium">Seu professor está analisando seu texto...</p>
            <p className="text-slate-500 text-sm">Isso pode levar alguns segundos</p>
          </div>
        )}

        {reviewState === 'error' && (
          <div className="bg-red-900/30 border border-red-800 rounded-xl p-4 text-center">
            <p className="text-red-300 text-sm">Erro ao revisar. Verifique sua conexão e tente novamente.</p>
          </div>
        )}

        {reviewState === 'done' && aiReview && (
          <TeacherReport
            review={aiReview}
            onReviewAgain={handleReview}
            reviewing={isReviewing}
          />
        )}
      </div>
    </div>
  );
}

// ── Teacher report ────────────────────────────────────────────────────────────

function TeacherReport({
  review,
  onReviewAgain,
  reviewing,
}: {
  review: AIFeedback;
  onReviewAgain: () => void;
  reviewing: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 py-2">
        <div className="h-px flex-1 bg-slate-700" />
        <span className="text-xs text-slate-500 font-medium uppercase tracking-wider">Revisão do Professor</span>
        <div className="h-px flex-1 bg-slate-700" />
      </div>

      <OverallScoreCard review={review} />
      <ScoresCard scores={review.scores} />
      <CorrectedTextCard text={review.correctedText} />
      {review.mainErrors.length > 0 && <ErrorBadgesCard errors={review.mainErrors} />}
      {review.errorExplanations && <ErrorExplanationsCard text={review.errorExplanations} />}
      {review.newVocabulary.length > 0 && <VocabularyCard items={review.newVocabulary} />}
      {review.nativeSuggestion && <NativeSuggestionCard text={review.nativeSuggestion} />}
      {review.teacherSummary && <TeacherSummaryCard text={review.teacherSummary} />}
      {review.optionalChallenge && <ChallengeCard text={review.optionalChallenge} />}

      <button
        onClick={onReviewAgain}
        disabled={reviewing}
        className="w-full py-2.5 rounded-xl text-xs text-slate-500 hover:text-slate-300 transition-colors"
      >
        Revisar novamente
      </button>
    </div>
  );
}

function OverallScoreCard({ review }: { review: AIFeedback }) {
  const color =
    review.overallScore >= 75 ? 'text-green-400' :
    review.overallScore >= 50 ? 'text-amber-400' :
    'text-red-400';
  return (
    <div className="bg-slate-800 rounded-xl p-5">
      <p className="text-xs text-slate-400 font-medium uppercase tracking-wider mb-4">Nota Geral</p>
      <div className="flex items-center justify-between">
        <span className={`text-6xl font-bold tabular-nums ${color}`}>{review.overallScore}</span>
        <div className="text-right space-y-2">
          <span className="block px-3 py-1 rounded-lg bg-blue-900 text-blue-300 text-sm font-bold">
            {review.estimatedLevel}
          </span>
          <span className={`block text-xs font-medium ${review.grammarGoalMet ? 'text-green-400' : 'text-amber-400'}`}>
            {review.grammarGoalMet ? '✓ Meta gramatical atingida' : '○ Continue praticando a meta'}
          </span>
        </div>
      </div>
    </div>
  );
}

function ScoresCard({ scores }: { scores: AIFeedback['scores'] }) {
  const items = [
    { label: 'Gramática', value: scores.grammar },
    { label: 'Vocabulário', value: scores.vocabulary },
    { label: 'Naturalidade', value: scores.naturalness },
    { label: 'Fluência', value: scores.fluency },
  ];
  return (
    <div className="bg-slate-800 rounded-xl p-5 space-y-3">
      <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Detalhamento</p>
      <div className="space-y-3">
        {items.map((item) => (
          <ScoreBar key={item.label} label={item.label} value={item.value} />
        ))}
      </div>
    </div>
  );
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  const color =
    value >= 75 ? 'bg-green-500' :
    value >= 50 ? 'bg-amber-500' :
    'bg-red-500';
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-slate-400 w-24 shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${value}%` }} />
      </div>
      <span className="text-xs text-slate-300 w-7 text-right tabular-nums">{value}</span>
    </div>
  );
}

function CorrectedTextCard({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <div className="bg-slate-800 rounded-xl p-5 space-y-3">
      <div className="flex justify-between items-center">
        <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Texto Corrigido</p>
        <button onClick={copy} className="text-xs text-blue-400 hover:text-blue-300 transition-colors">
          {copied ? '✓ Copiado' : 'Copiar'}
        </button>
      </div>
      <p className="text-slate-200 text-sm leading-relaxed whitespace-pre-wrap">{text}</p>
    </div>
  );
}

function ErrorBadgesCard({ errors }: { errors: string[] }) {
  return (
    <div className="bg-slate-800 rounded-xl p-5 space-y-3">
      <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Principais Erros</p>
      <div className="flex flex-wrap gap-2">
        {errors.map((err, i) => (
          <span
            key={i}
            className="px-2.5 py-1 rounded-lg bg-red-900/40 border border-red-800/50 text-red-300 text-xs"
          >
            {err}
          </span>
        ))}
      </div>
    </div>
  );
}

function ErrorExplanationsCard({ text }: { text: string }) {
  return (
    <div className="bg-slate-800 rounded-xl p-5 space-y-3">
      <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Explicações</p>
      <p className="text-slate-300 text-sm leading-relaxed">{text}</p>
    </div>
  );
}

function VocabularyCard({ items }: { items: VocabularyItem[] }) {
  return (
    <div className="bg-slate-800 rounded-xl p-5 space-y-3">
      <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Novo Vocabulário</p>
      <div className="space-y-3">
        {items.map((item, i) => (
          <div key={i} className="border-b border-slate-700 last:border-0 pb-3 last:pb-0">
            <div className="flex items-baseline gap-2 mb-0.5">
              <span className="text-blue-400 font-semibold text-sm">{item.word}</span>
              <span className="text-slate-500 text-xs">{item.meaning}</span>
            </div>
            <p className="text-slate-400 text-xs italic">"{item.example}"</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function NativeSuggestionCard({ text }: { text: string }) {
  return (
    <div className="bg-emerald-900/20 border border-emerald-800/30 rounded-xl p-5 space-y-3">
      <p className="text-xs text-emerald-400 font-medium uppercase tracking-wider">Como um nativo diria</p>
      <p className="text-slate-200 text-sm leading-relaxed italic">"{text}"</p>
    </div>
  );
}

function TeacherSummaryCard({ text }: { text: string }) {
  return (
    <div className="bg-blue-900/20 border border-blue-800/30 rounded-xl p-5 space-y-3">
      <p className="text-xs text-blue-400 font-medium uppercase tracking-wider">Resumo do Professor</p>
      <p className="text-slate-200 text-sm leading-relaxed">{text}</p>
    </div>
  );
}

function ChallengeCard({ text }: { text: string }) {
  return (
    <div className="bg-purple-900/20 border border-purple-800/30 rounded-xl p-5 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-lg">🎯</span>
        <p className="text-xs text-purple-400 font-medium uppercase tracking-wider">Desafio</p>
      </div>
      <p className="text-slate-300 text-sm leading-relaxed">{text}</p>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-sm">
      <span className="text-slate-500 shrink-0 w-24">{label}:</span>
      <span className="text-slate-200">{value}</span>
    </div>
  );
}

function StatusBadgePill({ status }: { status: Status }) {
  const map: Record<Status, string> = {
    'nao-iniciado': 'bg-slate-700 text-slate-400',
    'escrito': 'bg-blue-700 text-blue-200',
    'corrigido': 'bg-amber-700 text-amber-200',
    'revisado': 'bg-green-700 text-green-200',
  };
  const labels: Record<Status, string> = {
    'nao-iniciado': 'Não iniciado',
    'escrito': 'Escrito',
    'corrigido': 'Corrigido',
    'revisado': 'Revisado',
  };
  return (
    <span className={`px-2 py-1 rounded-md text-xs font-medium ${map[status]}`}>
      {labels[status]}
    </span>
  );
}
