import { useState, useEffect } from 'react';
import { EnglishLearningMemory, RecurringMistake, VocabularyItem, View } from '../types';
import { fetchLearningMemory, updateLearningMemory } from '../lib/learningMemory';
import { LearningSettings } from '../lib/learningSettings';

type LoadState = 'loading' | 'done' | 'empty' | 'error';

interface Props {
  onNavigate: (v: View) => void;
  onSettingsChange?: (settings: LearningSettings) => void;
}

export default function MemoryView({ onNavigate }: Props) {
  const [memory, setMemory] = useState<EnglishLearningMemory | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [isRecalculating, setIsRecalculating] = useState(false);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoadState('loading');
    try {
      const m = await fetchLearningMemory();
      if (m) { setMemory(m); setLoadState('done'); }
      else setLoadState('empty');
    } catch {
      setLoadState('error');
    }
  }

  async function recalculate() {
    if (isRecalculating) return;
    setIsRecalculating(true);
    try {
      const m = await updateLearningMemory();
      setMemory(m);
      setLoadState('done');
    } catch {
      /* silent — memory UI stays as-is */
    } finally {
      setIsRecalculating(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      <header className="sticky top-0 bg-slate-800 border-b border-slate-700 px-4 py-3 z-10">
        <h1 className="text-base font-semibold text-slate-100">Memória de aprendizado</h1>
        <p className="text-xs text-slate-400 mt-0.5">O app usa seus erros e revisões para personalizar os próximos treinos.</p>
      </header>

      <div className="flex-1 overflow-auto p-4 max-w-lg mx-auto w-full space-y-5 pb-20">

        {loadState === 'loading' && (
          <div className="flex flex-col items-center justify-center py-20 space-y-3">
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-slate-400 text-sm">Carregando sua memória de aprendizado...</p>
          </div>
        )}

        {loadState === 'error' && (
          <div className="bg-red-900/30 border border-red-800 rounded-xl p-6 text-center space-y-3">
            <p className="text-red-300 text-sm">Não foi possível carregar sua memória agora.</p>
            <button onClick={load} className="text-xs text-slate-400 hover:text-slate-200 transition-colors">
              Tentar novamente
            </button>
          </div>
        )}

        {loadState === 'empty' && (
          <div className="flex flex-col items-center justify-center py-16 text-center space-y-4">
            <p className="text-5xl">🧠</p>
            <p className="text-slate-300 font-medium">Sua memória ainda está vazia.</p>
            <p className="text-slate-500 text-sm">Ela será criada automaticamente após suas primeiras revisões, ou clique abaixo para calcular agora.</p>
            <button
              onClick={recalculate}
              disabled={isRecalculating}
              className="mt-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-medium transition-colors"
            >
              {isRecalculating ? 'Calculando...' : 'Calcular memória agora'}
            </button>
          </div>
        )}

        {loadState === 'done' && memory && (
          <>
            {/* Recalculate button */}
            <button
              onClick={recalculate}
              disabled={isRecalculating}
              className="w-full py-2 rounded-xl text-xs text-slate-500 hover:text-slate-300 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 transition-colors"
            >
              {isRecalculating ? '⏳ Recalculando...' : '🔄 Recalcular memória'}
            </button>

            {/* Card 1 — Resumo */}
            <section className="bg-slate-800 rounded-xl p-5 space-y-3">
              <SectionTitle>Resumo</SectionTitle>
              <div className="grid grid-cols-2 gap-3">
                <MiniCard label="Nível atual" value={memory.currentLevel} highlight="text-blue-400" />
                <MiniCard label="Média geral" value={`${memory.averageScore}/100`} highlight={scoreColor(memory.averageScore)} />
                <MiniCard label="Total de revisões" value={String(memory.totalReviews)} />
                <MiniCard label="Sequência atual" value={`${memory.currentStreak} dias`} />
              </div>
            </section>

            {/* Card 2 — Diagnóstico */}
            <section className="bg-slate-800 rounded-xl p-5 space-y-3">
              <SectionTitle>Diagnóstico</SectionTitle>
              <div className="grid grid-cols-2 gap-3">
                {memory.weakestSkill && (
                  <div className="bg-red-900/20 border border-red-800/30 rounded-lg p-3">
                    <p className="text-xs text-slate-500 mb-1">Ponto mais fraco</p>
                    <p className="text-sm font-semibold text-red-400">{skillLabel(memory.weakestSkill)}</p>
                  </div>
                )}
                {memory.strongestSkill && (
                  <div className="bg-green-900/20 border border-green-800/30 rounded-lg p-3">
                    <p className="text-xs text-slate-500 mb-1">Ponto mais forte</p>
                    <p className="text-sm font-semibold text-green-400">{skillLabel(memory.strongestSkill)}</p>
                  </div>
                )}
              </div>
              {memory.teacherSummary && (
                <div className="bg-blue-900/20 border border-blue-800/30 rounded-xl p-4">
                  <p className="text-xs text-blue-400 font-medium uppercase tracking-wider mb-1.5">Resumo do professor</p>
                  <p className="text-sm text-slate-200 leading-relaxed">{memory.teacherSummary}</p>
                </div>
              )}
              {memory.recommendedNextFocus && (
                <div className="bg-amber-900/20 border border-amber-800/30 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span>🎯</span>
                    <p className="text-xs text-amber-400 font-medium uppercase tracking-wider">Foco recomendado</p>
                  </div>
                  <p className="text-sm text-slate-200 leading-relaxed">{memory.recommendedNextFocus}</p>
                </div>
              )}
            </section>

            {/* Card 3 — Erros recorrentes */}
            <section className="bg-slate-800 rounded-xl p-5 space-y-4">
              <SectionTitle>Erros recorrentes</SectionTitle>
              {memory.recurringMistakes.length === 0 ? (
                <p className="text-xs text-slate-500">Ainda não há erros suficientes registrados.</p>
              ) : (
                memory.recurringMistakes.slice(0, 5).map((m, i) => (
                  <MistakeRow key={i} mistake={m} />
                ))
              )}
            </section>

            {/* Card 4 — Gramática para revisar */}
            {memory.grammarFocus.length > 0 && (
              <section className="bg-slate-800 rounded-xl p-5 space-y-3">
                <SectionTitle>Gramática para revisar</SectionTitle>
                <div className="flex flex-wrap gap-2">
                  {memory.grammarFocus.map((g, i) => (
                    <span key={i} className="px-2.5 py-1 bg-purple-900/40 border border-purple-800/40 rounded-lg text-xs text-purple-300 font-medium">
                      {g}
                    </span>
                  ))}
                </div>
              </section>
            )}

            {/* Card 5 — Vocabulário aprendido */}
            <section className="bg-slate-800 rounded-xl p-5 space-y-3">
              <SectionTitle>Vocabulário aprendido</SectionTitle>
              {memory.vocabularyLearned.length === 0 ? (
                <p className="text-xs text-slate-500">Vocabulário aparecerá aqui após suas próximas revisões.</p>
              ) : (
                <div className="space-y-3">
                  {memory.vocabularyLearned.slice(0, 10).map((v, i) => (
                    <VocabRow key={i} item={v} />
                  ))}
                </div>
              )}
            </section>

            {/* Card 6 — Próximo treino */}
            {memory.recommendedNextTheme && (
              <section className="bg-purple-900/20 border border-purple-800/30 rounded-xl p-5 space-y-3">
                <div className="flex items-center gap-2">
                  <span>🚀</span>
                  <SectionTitle className="text-purple-400">Próximo treino recomendado</SectionTitle>
                </div>
                <p className="text-slate-200 text-sm leading-relaxed">{memory.recommendedNextTheme}</p>
                <button
                  onClick={() => onNavigate('dashboard')}
                  className="mt-1 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition-colors"
                >
                  Começar treino
                </button>
              </section>
            )}
          </>
        )}

      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={`text-xs font-medium uppercase tracking-wider ${className ?? 'text-slate-400'}`}>
      {children}
    </p>
  );
}

function MiniCard({ label, value, highlight }: { label: string; value: string; highlight?: string }) {
  return (
    <div className="bg-slate-700/50 rounded-lg p-3">
      <p className="text-xs text-slate-500 mb-1">{label}</p>
      <p className={`text-xl font-bold tabular-nums ${highlight ?? 'text-slate-100'}`}>{value}</p>
    </div>
  );
}

function MistakeRow({ mistake }: { mistake: RecurringMistake }) {
  return (
    <div className="space-y-1 border-b border-slate-700 last:border-0 pb-3 last:pb-0">
      <div className="flex gap-2 text-xs">
        <span className="text-slate-500 shrink-0">Escrito:</span>
        <span className="text-red-400 italic">"{mistake.original}"</span>
        {mistake.count > 1 && (
          <span className="ml-auto text-slate-600">×{mistake.count}</span>
        )}
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
      {item.example && (
        <p className="text-slate-400 text-xs italic mt-0.5">"{item.example}"</p>
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function scoreColor(score: number): string {
  return score >= 75 ? 'text-green-400' : score >= 50 ? 'text-amber-400' : 'text-red-400';
}

function skillLabel(skill: string): string {
  const map: Record<string, string> = {
    grammar: 'Gramática',
    vocabulary: 'Vocabulário',
    naturalness: 'Naturalidade',
    fluency: 'Fluência',
  };
  return map[skill] ?? skill;
}
