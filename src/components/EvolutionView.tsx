import { useState, useEffect, useMemo } from 'react';
import { Sprout, Target } from 'lucide-react';
import { EnglishReviewSaved, MainMistake, VocabularyItem, View } from '../types';
import { fetchEnglishReviews } from '../lib/reviewsHistory';
import {
  calculateAverage,
  getUniquePracticeDays,
  calculateCurrentStreak,
  getRecentReviews,
  countLast7Days,
  countLast30Days,
  getRecommendedFocus,
  getRecentMistakes,
  getRecentVocabulary,
} from '../lib/evolutionStats';

type LoadState = 'loading' | 'done' | 'error';

interface Props {
  onNavigate: (v: View) => void;
}

export default function EvolutionView({ onNavigate }: Props) {
  const [reviews, setReviews] = useState<EnglishReviewSaved[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');

  function load() {
    setLoadState('loading');
    fetchEnglishReviews()
      .then((data) => { setReviews(data); setLoadState('done'); })
      .catch(() => setLoadState('error'));
  }

  useEffect(() => { load(); }, []);

  const stats = useMemo(() => {
    if (reviews.length === 0) return null;
    const asc = [...reviews].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return {
      totalReviews: reviews.length,
      averageScore: calculateAverage(reviews.map((r) => r.score)),
      latestScore: asc[asc.length - 1].score,
      latestLevel: asc[asc.length - 1].level,
      bestScore: Math.max(...reviews.map((r) => r.score)),
      averageGrammar: calculateAverage(reviews.map((r) => r.grammar)),
      averageVocabulary: calculateAverage(reviews.map((r) => r.vocabulary)),
      averageNaturalness: calculateAverage(reviews.map((r) => r.naturalness)),
      averageFluency: calculateAverage(reviews.map((r) => r.fluency)),
      practicedDays: getUniquePracticeDays(reviews).length,
      currentStreak: calculateCurrentStreak(reviews),
      last7Days: countLast7Days(reviews),
      last30Days: countLast30Days(reviews),
      recentReviews: getRecentReviews(reviews, 7),
      focus: getRecommendedFocus(reviews),
      mistakes: getRecentMistakes(reviews, 5),
      vocabulary: getRecentVocabulary(reviews, 10),
    };
  }, [reviews]);

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      <header className="sticky top-0 bg-slate-800 border-b border-slate-700 px-4 py-3 z-10">
        <h1 className="text-base font-semibold text-slate-100">Minha evolução</h1>
        <p className="text-xs text-slate-400 mt-0.5">Acompanhe seu progresso no writing em inglês.</p>
      </header>

      <div className="flex-1 overflow-auto p-4 max-w-lg mx-auto w-full space-y-5 pb-20">

        {loadState === 'loading' && (
          <div className="flex flex-col items-center justify-center py-20 space-y-3">
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-slate-400 text-sm">Carregando sua evolução...</p>
          </div>
        )}

        {loadState === 'error' && (
          <div className="bg-red-900/30 border border-red-800 rounded-xl p-6 text-center space-y-3">
            <p className="text-red-300 text-sm">Não foi possível carregar sua evolução agora.</p>
            <button onClick={load} className="text-xs text-slate-400 hover:text-slate-200 transition-colors">
              Tentar novamente
            </button>
          </div>
        )}

        {loadState === 'done' && reviews.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center space-y-3">
            <Sprout className="w-12 h-12 text-slate-500 shrink-0" strokeWidth={1.5} aria-hidden="true" />
            <p className="text-slate-300 font-medium">Você ainda não tem revisões suficientes.</p>
            <p className="text-slate-500 text-sm">Faça sua primeira revisão com IA para ver sua evolução aqui.</p>
            <button
              onClick={() => onNavigate('dashboard')}
              className="mt-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors"
            >
              Fazer uma revisão
            </button>
          </div>
        )}

        {loadState === 'done' && stats && (
          <>
            {/* ── Main stats grid ── */}
            <div className="grid grid-cols-2 gap-3">
              <StatCard label="Textos revisados" value={String(stats.totalReviews)} />
              <StatCard label="Média geral" value={`${stats.averageScore}/100`} highlight={scoreColor(stats.averageScore)} />
              <StatCard label="Última nota" value={`${stats.latestScore}/100`} sub={stats.latestLevel} highlight={scoreColor(stats.latestScore)} />
              <StatCard label="Melhor nota" value={`${stats.bestScore}/100`} highlight={scoreColor(stats.bestScore)} />
              <StatCard label="Dias praticados" value={String(stats.practicedDays)} />
              <StatCard label="Sequência atual" value={`${stats.currentStreak} dias`} />
            </div>

            {/* ── Activity ── */}
            <div className="bg-slate-800 rounded-xl p-4 flex gap-4">
              <div className="flex-1 text-center">
                <p className="text-2xl font-bold text-blue-400 tabular-nums">{stats.last7Days}</p>
                <p className="text-xs text-slate-400 mt-0.5">Últimos 7 dias</p>
              </div>
              <div className="w-px bg-slate-700" />
              <div className="flex-1 text-center">
                <p className="text-2xl font-bold text-blue-400 tabular-nums">{stats.last30Days}</p>
                <p className="text-xs text-slate-400 mt-0.5">Últimos 30 dias</p>
              </div>
            </div>

            {/* ── Skills ── */}
            <section className="bg-slate-800 rounded-xl p-5 space-y-3">
              <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Habilidades</p>
              <ScoreBar label="Gramática" value={stats.averageGrammar} />
              <ScoreBar label="Vocabulário" value={stats.averageVocabulary} />
              <ScoreBar label="Naturalidade" value={stats.averageNaturalness} />
              <ScoreBar label="Fluência" value={stats.averageFluency} />
            </section>

            {/* ── Recent evolution ── */}
            {stats.recentReviews.length > 0 && (
              <section className="bg-slate-800 rounded-xl p-5 space-y-3">
                <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Evolução recente</p>
                <div className="space-y-2">
                  {stats.recentReviews.map((r) => (
                    <div key={r.id} className="flex items-center gap-3">
                      <span className="text-xs text-slate-500 shrink-0 w-14">{shortDate(r.createdAt)}</span>
                      <div className="flex-1 h-2 bg-slate-700 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${barColor(r.score)}`}
                          style={{ width: `${r.score}%` }}
                        />
                      </div>
                      <span className={`text-xs font-bold tabular-nums w-8 text-right ${scoreColor(r.score)}`}>{r.score}</span>
                      <span className="text-xs text-blue-400 font-bold w-6 text-right">{r.level}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* ── Recommended focus ── */}
            <section className="bg-amber-900/20 border border-amber-800/30 rounded-xl p-5 space-y-2">
              <div className="flex items-center gap-2">
                <Target className="w-4 h-4 shrink-0 text-amber-400" strokeWidth={2} aria-hidden="true" />
                <p className="text-xs text-amber-400 font-medium uppercase tracking-wider">Foco recomendado</p>
              </div>
              <p className="text-slate-200 text-sm leading-relaxed">{stats.focus}</p>
            </section>

            {/* ── Recent mistakes ── */}
            <section className="bg-slate-800 rounded-xl p-5 space-y-4">
              <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Erros para revisar</p>
              {stats.mistakes.length === 0 ? (
                <p className="text-xs text-slate-500">Ainda não há erros suficientes para analisar.</p>
              ) : (
                stats.mistakes.map((m, i) => <MistakeRow key={i} mistake={m} />)
              )}
            </section>

            {/* ── Recent vocabulary ── */}
            <section className="bg-slate-800 rounded-xl p-5 space-y-3">
              <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Vocabulário recente</p>
              {stats.vocabulary.length === 0 ? (
                <p className="text-xs text-slate-500">Seu vocabulário novo aparecerá aqui depois das próximas revisões.</p>
              ) : (
                <div className="space-y-3">
                  {stats.vocabulary.map((v, i) => <VocabRow key={i} item={v} />)}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: string }) {
  return (
    <div className="bg-slate-800 rounded-xl p-4">
      <p className="text-xs text-slate-400 mb-1">{label}</p>
      <p className={`text-2xl font-bold tabular-nums ${highlight ?? 'text-slate-100'}`}>{value}</p>
      {sub && <p className="text-xs text-blue-400 font-bold mt-0.5">{sub}</p>}
    </div>
  );
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-slate-400 w-24 shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${barColor(value)}`} style={{ width: `${value}%` }} />
      </div>
      <span className="text-xs text-slate-300 w-12 text-right tabular-nums">{value}/100</span>
    </div>
  );
}

function MistakeRow({ mistake }: { mistake: MainMistake }) {
  return (
    <div className="space-y-1 border-b border-slate-700 last:border-0 pb-3 last:pb-0">
      <div className="flex gap-2 text-xs">
        <span className="text-slate-500 shrink-0">Escrito:</span>
        <span className="text-red-400 italic">"{mistake.original}"</span>
      </div>
      <div className="flex gap-2 text-xs">
        <span className="text-slate-500 shrink-0">Correto:</span>
        <span className="text-green-400 italic">"{mistake.correct}"</span>
      </div>
      <p className="text-xs text-slate-400 leading-relaxed">{mistake.explanation}</p>
    </div>
  );
}

function VocabRow({ item }: { item: VocabularyItem }) {
  return (
    <div className="border-b border-slate-700 last:border-0 pb-3 last:pb-0">
      <div className="flex items-baseline gap-2">
        <span className="text-blue-400 font-semibold text-sm">{item.word}</span>
        <span className="text-slate-500 text-xs">{item.meaningPtBr}</span>
      </div>
      <p className="text-slate-400 text-xs italic mt-0.5">"{item.example}"</p>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function scoreColor(score: number): string {
  return score >= 75 ? 'text-green-400' : score >= 50 ? 'text-amber-400' : 'text-red-400';
}

function barColor(score: number): string {
  return score >= 75 ? 'bg-green-500' : score >= 50 ? 'bg-amber-500' : 'bg-red-500';
}

function shortDate(iso: string): string {
  try {
    const d = new Date(iso);
    return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  } catch {
    return '—';
  }
}
