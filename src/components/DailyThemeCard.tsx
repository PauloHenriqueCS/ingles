import { useState } from 'react';
import { EnglishDailyTheme } from '../types';
import { fetchEnglishReviews } from '../lib/reviewsHistory';
import { buildLearningContextForTheme } from '../lib/themeContext';
import { fetchLearningMemory } from '../lib/learningMemory';

type GenState = 'idle' | 'loading' | 'error';

interface Props {
  theme: EnglishDailyTheme | null;
  onThemeReady: (theme: EnglishDailyTheme) => void;
  onStartWriting: () => void;
}

export default function DailyThemeCard({ theme, onThemeReady, onStartWriting }: Props) {
  const [genState, setGenState] = useState<GenState>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const isLoading = genState === 'loading';

  async function generate() {
    setGenState('loading');
    setErrorMsg(null);
    try {
      // Prefer consolidated memory; fall back to reviews-based context
      const memory = await fetchLearningMemory();
      let context;
      if (memory) {
        context = {
          currentLevel: memory.currentLevel,
          averageScore: memory.averageScore,
          weakestSkill: memory.weakestSkill,
          grammarFocus: memory.grammarFocus,
          recentMistakes: memory.recurringMistakes
            .slice(0, 5)
            .map((m) => m.explanation || `${m.original} → ${m.correct}`),
          recentVocabulary: memory.vocabularyToReview.slice(0, 8).map((v) => v.word),
          lastObjectives: memory.recommendedNextFocus ? [memory.recommendedNextFocus] : [],
          lastNextPractices: memory.recommendedNextTheme ? [memory.recommendedNextTheme] : [],
        };
      } else {
        const reviews = await fetchEnglishReviews(10);
        context = buildLearningContextForTheme(reviews);
      }
      const res = await fetch('/api/generate-theme', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ learningContext: context }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Erro ao gerar tema');
      onThemeReady(data.theme as EnglishDailyTheme);
      setGenState('idle');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Erro ao gerar tema');
      setGenState('error');
    }
  }

  return (
    <div className="bg-slate-800 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 pt-4 pb-2">
        <span className="text-base">✨</span>
        <p className="text-sm font-semibold text-slate-100">Tema do dia</p>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="px-4 pb-6 flex flex-col items-center gap-3 py-4">
          <div className="w-7 h-7 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-xs text-slate-400">Gerando seu tema personalizado...</p>
        </div>
      )}

      {/* No theme yet */}
      {!theme && !isLoading && (
        <div className="px-4 pb-4 space-y-3">
          {genState === 'error' ? (
            <p className="text-xs text-red-400">
              {errorMsg || 'Não foi possível gerar o tema agora. Tente novamente.'}
            </p>
          ) : (
            <p className="text-xs text-slate-400">
              Não sabe o que escrever hoje? A IA cria um exercício personalizado baseado no seu histórico.
            </p>
          )}
          <button
            onClick={generate}
            disabled={isLoading}
            className="w-full py-2.5 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 transition-colors"
          >
            {genState === 'error' ? 'Tentar novamente' : 'Gerar tema com IA'}
          </button>
        </div>
      )}

      {/* Theme ready */}
      {theme && !isLoading && (
        <div className="px-4 pb-4 space-y-4">
          <p className="text-xs text-blue-400 italic">
            Hoje seu treino foi criado com base no seu histórico recente.
          </p>

          {/* Title + badges */}
          <div className="space-y-1.5">
            <p className="text-base font-bold text-slate-100">{theme.title}</p>
            <div className="flex items-center gap-2 flex-wrap">
              <LevelBadge level={theme.level} />
              <DiffBadge difficulty={theme.difficulty} />
              <span className="text-xs text-slate-500">⏱ {theme.estimatedTimeMinutes} min</span>
            </div>
          </div>

          {/* Theme text */}
          <div className="space-y-2">
            <p className="text-sm text-slate-200 leading-relaxed">{theme.themePtBr}</p>
            <p className="text-sm text-blue-300 font-medium italic">{theme.themeEn}</p>
            {theme.objective && (
              <p className="text-xs text-slate-400 leading-relaxed">
                <span className="text-slate-500">Objetivo: </span>{theme.objective}
              </p>
            )}
          </div>

          {/* Instructions */}
          {theme.instructions.length > 0 && (
            <Section title="Instruções">
              <ol className="space-y-1 list-decimal list-inside">
                {theme.instructions.map((item, i) => (
                  <li key={i} className="text-xs text-slate-300 leading-relaxed">{item}</li>
                ))}
              </ol>
            </Section>
          )}

          {/* Required grammar */}
          {theme.requiredGrammar.length > 0 && (
            <Section title="Gramática">
              <div className="flex flex-wrap gap-1.5">
                {theme.requiredGrammar.map((g, i) => (
                  <span key={i} className="px-2 py-0.5 bg-purple-900/40 border border-purple-800/40 rounded text-xs text-purple-300">
                    {g}
                  </span>
                ))}
              </div>
            </Section>
          )}

          {/* Suggested vocabulary */}
          {theme.suggestedVocabulary.length > 0 && (
            <Section title="Vocabulário sugerido">
              <div className="space-y-2">
                {theme.suggestedVocabulary.map((v, i) => (
                  <div key={i}>
                    <div className="flex items-baseline gap-2">
                      <span className="text-blue-400 font-semibold text-sm">{v.word}</span>
                      <span className="text-slate-500 text-xs">{v.meaningPtBr}</span>
                    </div>
                    {v.example && (
                      <p className="text-slate-500 text-xs italic">"{v.example}"</p>
                    )}
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Use these words */}
          {theme.useTheseWords.length > 0 && (
            <Section title="Tente usar estas palavras">
              <div className="flex flex-wrap gap-1.5">
                {theme.useTheseWords.map((w, i) => (
                  <span key={i} className="px-2 py-0.5 bg-slate-700 rounded text-xs text-slate-300 font-mono">
                    {w}
                  </span>
                ))}
              </div>
            </Section>
          )}

          {/* Example sentence */}
          {theme.exampleSentence && (
            <Section title="Exemplo">
              <p className="text-xs text-green-400 italic">"{theme.exampleSentence}"</p>
            </Section>
          )}

          {/* Success criteria */}
          {theme.successCriteria.length > 0 && (
            <Section title="Critérios de sucesso">
              <ul className="space-y-1">
                {theme.successCriteria.map((c, i) => (
                  <li key={i} className="flex gap-2 text-xs text-slate-300">
                    <span className="text-green-500 shrink-0">✓</span>
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {/* Action buttons */}
          <div className="flex gap-2 pt-1">
            <button
              onClick={generate}
              disabled={isLoading}
              className="flex-1 py-2.5 rounded-xl text-xs font-medium text-slate-400 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 transition-colors"
            >
              Gerar outro tema
            </button>
            <button
              onClick={onStartWriting}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors"
            >
              Começar texto
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-slate-500 font-medium uppercase tracking-wider">{title}</p>
      {children}
    </div>
  );
}

function LevelBadge({ level }: { level: string }) {
  return (
    <span className="px-2 py-0.5 rounded bg-blue-900 text-blue-300 text-xs font-bold">{level}</span>
  );
}

function DiffBadge({ difficulty }: { difficulty: string }) {
  const cls: Record<string, string> = {
    easy: 'bg-green-900/40 text-green-400',
    medium: 'bg-amber-900/40 text-amber-400',
    hard: 'bg-red-900/40 text-red-400',
  };
  const labels: Record<string, string> = { easy: 'Fácil', medium: 'Médio', hard: 'Difícil' };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${cls[difficulty] ?? 'bg-slate-700 text-slate-400'}`}>
      {labels[difficulty] ?? difficulty}
    </span>
  );
}
