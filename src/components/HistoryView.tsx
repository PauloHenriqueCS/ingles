import { useState, useEffect } from 'react';
import { EnglishReviewSaved, EnglishDailyTheme, RewriteComparisonResult, MainMistake, VocabularyItem } from '../types';
import { fetchEnglishReviews } from '../lib/reviewsHistory';

type LoadState = 'loading' | 'done' | 'error';

export default function HistoryView() {
  const [reviews, setReviews] = useState<EnglishReviewSaved[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [selected, setSelected] = useState<EnglishReviewSaved | null>(null);

  useEffect(() => {
    fetchEnglishReviews()
      .then((data) => { setReviews(data); setLoadState('done'); })
      .catch(() => setLoadState('error'));
  }, []);

  if (selected) {
    return <ReviewDetail review={selected} onBack={() => setSelected(null)} />;
  }

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      <header className="sticky top-0 bg-slate-800 border-b border-slate-700 px-4 py-3 z-10">
        <h1 className="text-base font-semibold text-slate-100">Histórico de Revisões</h1>
      </header>

      <div className="flex-1 overflow-auto p-4 max-w-lg mx-auto w-full space-y-3 pb-20">
        {loadState === 'loading' && (
          <div className="flex flex-col items-center justify-center py-20 space-y-3">
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-slate-400 text-sm">Carregando seu histórico...</p>
          </div>
        )}

        {loadState === 'error' && (
          <div className="bg-red-900/30 border border-red-800 rounded-xl p-6 text-center">
            <p className="text-red-300 text-sm">Não foi possível carregar o histórico agora.</p>
            <button
              onClick={() => { setLoadState('loading'); fetchEnglishReviews().then((d) => { setReviews(d); setLoadState('done'); }).catch(() => setLoadState('error')); }}
              className="mt-3 text-xs text-slate-400 hover:text-slate-200 transition-colors"
            >
              Tentar novamente
            </button>
          </div>
        )}

        {loadState === 'done' && reviews.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center space-y-2">
            <p className="text-4xl">📝</p>
            <p className="text-slate-300 text-sm font-medium">Nenhuma revisão ainda.</p>
            <p className="text-slate-500 text-xs">Faça sua primeira revisão com IA para ela aparecer aqui.</p>
          </div>
        )}

        {loadState === 'done' && reviews.map((r) => (
          <ReviewCard key={r.id} review={r} onOpen={() => setSelected(r)} />
        ))}
      </div>
    </div>
  );
}

// ── Review card (list) ────────────────────────────────────────────────────────

function ReviewCard({ review, onOpen }: { review: EnglishReviewSaved; onOpen: () => void }) {
  const scoreColor =
    review.score >= 75 ? 'text-green-400' :
    review.score >= 50 ? 'text-amber-400' : 'text-red-400';

  const dateLabel = formatDate(review.createdAt);

  return (
    <div className="bg-slate-800 rounded-xl p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <p className="text-xs text-slate-400">{dateLabel}</p>
          {review.category && (
            <p className="text-sm font-medium text-slate-200 line-clamp-1">{review.category}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="px-2 py-0.5 rounded bg-blue-900 text-blue-300 text-xs font-bold">
            {review.level}
          </span>
          <span className={`text-lg font-bold tabular-nums ${scoreColor}`}>{review.score}</span>
        </div>
      </div>

      <div className="space-y-1 text-xs text-slate-400">
        {review.difficulty && (
          <p><span className="text-slate-500">Dificuldade:</span> <span className="capitalize">{review.difficulty}</span></p>
        )}
        {review.objective && (
          <p><span className="text-slate-500">Objetivo:</span> {review.objective}</p>
        )}
      </div>

      {review.summary && (
        <p className="text-xs text-slate-400 leading-relaxed line-clamp-2">{review.summary}</p>
      )}

      <button
        onClick={onOpen}
        className="w-full py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs text-slate-200 font-medium transition-colors"
      >
        Ver detalhes
      </button>
    </div>
  );
}

// ── Detail view ───────────────────────────────────────────────────────────────

function ReviewDetail({ review, onBack }: { review: EnglishReviewSaved; onBack: () => void }) {
  const scoreColor =
    review.score >= 75 ? 'text-green-400' :
    review.score >= 50 ? 'text-amber-400' : 'text-red-400';

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      <header className="sticky top-0 bg-slate-800 border-b border-slate-700 px-4 py-3 flex items-center gap-3 z-10">
        <button onClick={onBack} className="text-slate-400 hover:text-slate-100 text-lg">←</button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-100 truncate">{review.category ?? 'Revisão'}</p>
          <p className="text-xs text-slate-400">{formatDate(review.createdAt)}</p>
        </div>
        <span className="px-2 py-1 rounded bg-blue-900 text-blue-300 text-xs font-bold">{review.level}</span>
      </header>

      <div className="flex-1 overflow-auto p-4 max-w-lg mx-auto w-full space-y-4 pb-10">

        {/* Scores */}
        <div className="bg-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">Nota Geral</p>
              <span className={`text-5xl font-bold tabular-nums ${scoreColor}`}>{review.score}</span>
              <span className="text-slate-500 text-base">/100</span>
            </div>
            {review.difficulty && (
              <span className="text-xs text-slate-400 capitalize bg-slate-700 px-2 py-1 rounded-lg">
                {review.difficulty}
              </span>
            )}
          </div>
          <div className="space-y-2 pt-2 border-t border-slate-700">
            <ScoreBar label="Gramática" value={review.grammar} />
            <ScoreBar label="Vocabulário" value={review.vocabulary} />
            <ScoreBar label="Naturalidade" value={review.naturalness} />
            <ScoreBar label="Fluência" value={review.fluency} />
          </div>
        </div>

        {/* Summary */}
        {review.summary && (
          <div className="bg-blue-900/20 border border-blue-800/30 rounded-xl p-4 space-y-2">
            <p className="text-xs text-blue-400 font-medium uppercase tracking-wider">Resumo do Professor</p>
            <p className="text-slate-200 text-sm leading-relaxed">{review.summary}</p>
          </div>
        )}

        {/* Mission snapshot */}
        {review.missionSnapshot && (
          <MissionCard mission={review.missionSnapshot} />
        )}

        {/* Original text */}
        <div className="bg-slate-800 rounded-xl p-4 space-y-2">
          <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Seu Texto Original</p>
          <p className="text-slate-300 text-sm leading-relaxed whitespace-pre-wrap">{review.originalText}</p>
        </div>

        {/* Corrected text */}
        {review.correctedText && (
          <div className="bg-slate-800 rounded-xl p-4 space-y-2">
            <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Texto Corrigido</p>
            <p className="text-slate-200 text-sm leading-relaxed whitespace-pre-wrap">{review.correctedText}</p>
          </div>
        )}

        {/* Main mistakes */}
        {review.mainMistakes.length > 0 && (
          <MainMistakesCard items={review.mainMistakes} />
        )}

        {/* Vocabulary */}
        {review.newVocabulary.length > 0 && (
          <VocabularyCard items={review.newVocabulary} />
        )}

        {/* Objective feedback */}
        {review.objectiveFeedback && (
          <div className="bg-amber-900/20 border border-amber-800/30 rounded-xl p-4 space-y-2">
            <div className="flex items-center gap-2">
              <span>⚠️</span>
              <p className="text-xs text-amber-400 font-medium uppercase tracking-wider">Feedback do Objetivo</p>
            </div>
            {review.objective && <p className="text-xs text-slate-500 italic">{review.objective}</p>}
            <p className="text-slate-200 text-sm leading-relaxed">{review.objectiveFeedback}</p>
          </div>
        )}

        {/* Next practice */}
        {review.nextPractice && (
          <div className="bg-purple-900/20 border border-purple-800/30 rounded-xl p-4 space-y-2">
            <div className="flex items-center gap-2">
              <span>🎯</span>
              <p className="text-xs text-purple-400 font-medium uppercase tracking-wider">Próxima Prática</p>
            </div>
            <p className="text-slate-300 text-sm leading-relaxed">{review.nextPractice}</p>
          </div>
        )}

        {/* Version 2 */}
        {review.version2Text && (
          <div className="bg-slate-800 rounded-xl p-4 space-y-2">
            <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Versão 2</p>
            <p className="text-slate-300 text-sm leading-relaxed whitespace-pre-wrap">{review.version2Text}</p>
          </div>
        )}

        {review.version2Comparison && (
          <V2ComparisonCard comparison={review.version2Comparison} />
        )}
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ScoreBar({ label, value }: { label: string; value: number }) {
  const color = value >= 75 ? 'bg-green-500' : value >= 50 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-slate-400 w-24 shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width: `${value}%` }} />
      </div>
      <span className="text-xs text-slate-300 w-7 text-right tabular-nums">{value}</span>
    </div>
  );
}

function MainMistakesCard({ items }: { items: MainMistake[] }) {
  return (
    <div className="bg-slate-800 rounded-xl p-4 space-y-4">
      <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Principais Erros</p>
      {items.map((item, i) => (
        <div key={i} className="space-y-1.5 border-b border-slate-700 last:border-0 pb-4 last:pb-0">
          <div className="flex gap-2 text-xs">
            <span className="text-slate-500 shrink-0 w-24">Você escreveu:</span>
            <span className="text-red-400 italic">"{item.original}"</span>
          </div>
          <div className="flex gap-2 text-xs">
            <span className="text-slate-500 shrink-0 w-24">Correção:</span>
            <span className="text-green-400 italic">"{item.correct}"</span>
          </div>
          <div className="flex gap-2 text-xs">
            <span className="text-slate-500 shrink-0 w-24">Explicação:</span>
            <span className="text-slate-300 leading-relaxed">{item.explanation}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function VocabularyCard({ items }: { items: VocabularyItem[] }) {
  return (
    <div className="bg-slate-800 rounded-xl p-4 space-y-3">
      <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Vocabulário Novo</p>
      <div className="space-y-3">
        {items.map((item, i) => (
          <div key={i} className="border-b border-slate-700 last:border-0 pb-3 last:pb-0">
            <div className="flex items-baseline gap-2 mb-0.5">
              <span className="text-blue-400 font-semibold text-sm">{item.word}</span>
              <span className="text-slate-500 text-xs">{item.meaningPtBr}</span>
            </div>
            <p className="text-slate-400 text-xs italic">"{item.example}"</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Mission card ──────────────────────────────────────────────────────────────

function MissionCard({ mission }: { mission: EnglishDailyTheme }) {
  return (
    <div className="bg-slate-800 rounded-xl p-4 space-y-2">
      <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Missão</p>
      <p className="text-slate-200 text-sm font-semibold">{mission.title}</p>
      {mission.mission && (
        <p className="text-slate-400 text-xs leading-relaxed">{mission.mission}</p>
      )}
      {mission.objective && (
        <p className="text-slate-500 text-xs italic">Objetivo: {mission.objective}</p>
      )}
    </div>
  );
}

// ── V2 comparison card ────────────────────────────────────────────────────────

function V2ComparisonCard({ comparison }: { comparison: RewriteComparisonResult }) {
  const scoreColor =
    comparison.improvementScore >= 75 ? 'text-green-400' :
    comparison.improvementScore >= 50 ? 'text-amber-400' : 'text-red-400';

  return (
    <div className="bg-slate-800 rounded-xl p-4 space-y-3">
      <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Resultado da Versão 2</p>
      <div className="flex items-center gap-4">
        <div>
          <span className={`text-4xl font-bold tabular-nums ${scoreColor}`}>{comparison.improvementScore}</span>
          <span className="text-slate-500 text-lg">/100</span>
        </div>
        <div className="flex gap-3 ml-auto">
          <div className="text-center">
            <p className="text-xl font-bold text-green-400 tabular-nums">{comparison.fixedMistakesCount}</p>
            <p className="text-xs text-slate-500">corrigidos</p>
          </div>
          <div className="text-center">
            <p className="text-xl font-bold text-amber-400 tabular-nums">{comparison.remainingMistakesCount}</p>
            <p className="text-xs text-slate-500">restantes</p>
          </div>
        </div>
      </div>
      {comparison.overallFeedback && (
        <p className="text-sm text-slate-300 leading-relaxed border-t border-slate-700 pt-3">
          {comparison.overallFeedback}
        </p>
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('pt-BR', {
      day: '2-digit', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
