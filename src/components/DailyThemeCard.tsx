import { useState } from 'react';
import { EnglishDailyTheme, ResponseExample } from '../types';
import { fetchEnglishReviews } from '../lib/reviewsHistory';
import { buildLearningContextForTheme } from '../lib/themeContext';
import { fetchLearningMemory } from '../lib/learningMemory';
import GrammarHelpModal from './GrammarHelpModal';

type GenState = 'idle' | 'loading' | 'error';

interface Props {
  theme: EnglishDailyTheme | null;
  onThemeReady: (theme: EnglishDailyTheme) => void;
  onStartWriting: () => void;
}

const FORMAT_LABELS: Record<string, string> = {
  'e-mail': 'E-mail',
  'diário': 'Diário',
  'mensagem': 'Mensagem',
  'conversa': 'Conversa',
  'entrevista': 'Entrevista',
  'relatório': 'Relatório',
  'review': 'Review',
  'história': 'História',
  'carta': 'Carta',
  'postagem': 'Postagem',
  'comentário': 'Comentário',
  'apresentação': 'Apresentação',
  'explicação': 'Explicação',
  'tutorial': 'Tutorial',
  'debate': 'Debate',
  'opinião': 'Opinião',
  // legacy activity_type values
  'email_formal': 'E-mail formal',
  'email_informal': 'E-mail informal',
  'whatsapp_chat': 'Chat / WhatsApp',
  'job_interview': 'Entrevista',
  'movie_review': 'Review de filme',
  'narrative': 'Narrativa',
};

function formatLabel(format: string | undefined, activityType: string | undefined): string | null {
  const key = format || activityType;
  if (!key) return null;
  return FORMAT_LABELS[key] ?? key.replace(/_/g, ' ');
}

export default function DailyThemeCard({ theme, onThemeReady, onStartWriting }: Props) {
  const [genState, setGenState] = useState<GenState>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [currentThemeId, setCurrentThemeId] = useState<string | null>(null);
  const [grammarModal, setGrammarModal] = useState<string | null>(null);
  const isLoading = genState === 'loading';

  async function generate() {
    setGenState('loading');
    setErrorMsg(null);

    const excludedTheme = theme
      ? {
          title: theme.title,
          format: theme.format,
          activityType: theme.activityType,
          conflict: theme.conflict,
          context: theme.context,
          semanticSummary: theme.semanticSummary,
        }
      : null;

    try {
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
        body: JSON.stringify({
          learningContext: context,
          previousThemeId: currentThemeId,
          excludedTheme,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Erro ao gerar missão');

      onThemeReady(data.theme as EnglishDailyTheme);
      setCurrentThemeId(data.themeId ?? null);
      setGenState('idle');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Erro ao gerar missão');
      setGenState('error');
    }
  }

  return (
    <div className="bg-slate-800 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 pt-4 pb-2">
        <span className="text-base">🎯</span>
        <p className="text-sm font-semibold text-slate-100">Missão do dia</p>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="px-4 pb-6 flex flex-col items-center gap-3 py-4">
          <div className="w-7 h-7 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-xs text-slate-400">Criando sua missão...</p>
        </div>
      )}

      {/* No theme yet */}
      {!theme && !isLoading && (
        <div className="px-4 pb-4 space-y-3">
          {genState === 'error' ? (
            <p className="text-xs text-red-400">
              {errorMsg || 'Não foi possível gerar a missão. Tente novamente.'}
            </p>
          ) : (
            <p className="text-xs text-slate-400">
              A IA cria uma missão personalizada baseada no seu histórico. Cada missão é uma situação real para resolver.
            </p>
          )}
          <button
            onClick={generate}
            disabled={isLoading}
            className="w-full py-2.5 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 transition-colors"
          >
            {genState === 'error' ? 'Tentar novamente' : 'Receber missão'}
          </button>
        </div>
      )}

      {/* Mission ready */}
      {theme && !isLoading && (
        <div className="px-4 pb-4 space-y-4">

          {/* Format + context + level/diff/time badges */}
          <div className="flex items-center gap-2 flex-wrap">
            {formatLabel(theme.format, theme.activityType) && (
              <span className="px-2 py-0.5 rounded bg-indigo-900/50 border border-indigo-700/40 text-indigo-300 text-xs font-medium">
                {formatLabel(theme.format, theme.activityType)}
              </span>
            )}
            {theme.context && (
              <span className="px-2 py-0.5 rounded bg-slate-700 text-slate-400 text-xs">
                {theme.context.replace(/_/g, ' ')}
              </span>
            )}
            <LevelBadge level={theme.level} />
            <DiffBadge difficulty={theme.difficulty} />
            <span className="text-xs text-slate-500">⏱ {theme.estimatedTimeMinutes} min</span>
          </div>

          {/* Title */}
          <p className="text-base font-bold text-slate-100">{theme.title}</p>

          {/* Mission card — the centerpiece */}
          <MissionCard theme={theme} />

          {/* English command */}
          {theme.themeEn && (
            <p className="text-sm text-blue-300 font-medium italic">{theme.themeEn}</p>
          )}

          {/* Why this activity */}
          {theme.whyThisActivity && (
            <p className="text-xs text-slate-500 italic leading-relaxed">{theme.whyThisActivity}</p>
          )}

          {/* Instructions */}
          {theme.instructions.length > 0 && (
            <Section title="Como fazer">
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
                  <div key={i} className="flex items-center gap-1">
                    <span className="px-2 py-0.5 bg-purple-900/40 border border-purple-800/40 rounded text-xs text-purple-300">
                      {g}
                    </span>
                    <button
                      onClick={() => setGrammarModal(g)}
                      className="w-5 h-5 flex items-center justify-center rounded-full text-slate-500 hover:text-slate-300 hover:bg-slate-700 transition-colors text-xs leading-none"
                      aria-label={`Explicação de ${g}`}
                      title={`Ver explicação de ${g}`}
                    >
                      ⓘ
                    </button>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Suggested vocabulary */}
          {theme.suggestedVocabulary.length > 0 && (
            <Section title="Vocabulário útil para esta missão">
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
            <Section title="Palavras para usar">
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

          {/* Response examples */}
          {theme.responseExamples && theme.responseExamples.length > 0 && (
            <ResponseExamplesSection examples={theme.responseExamples} />
          )}

          {/* Success criteria */}
          {theme.successCriteria.length > 0 && (
            <Section title="Missão cumprida quando...">
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

          {/* Extra challenge */}
          {theme.extraChallenge && (
            <Section title="Desafio extra">
              <p className="text-xs text-amber-400 leading-relaxed">{theme.extraChallenge}</p>
            </Section>
          )}

          {/* Action buttons */}
          <div className="flex gap-2 pt-1">
            <button
              onClick={generate}
              disabled={isLoading}
              className="flex-1 py-2.5 rounded-xl text-xs font-medium text-slate-400 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 transition-colors"
            >
              Outra missão
            </button>
            <button
              onClick={onStartWriting}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors"
            >
              Aceitar missão
            </button>
          </div>
        </div>
      )}
      {grammarModal && (
        <GrammarHelpModal
          grammarName={grammarModal}
          missionTip={theme?.grammarTips?.[grammarModal]}
          onClose={() => setGrammarModal(null)}
        />
      )}
    </div>
  );
}

// ── Mission card ──────────────────────────────────────────────────────────────

function MissionCard({ theme }: { theme: EnglishDailyTheme }) {
  const hasConflict = Boolean(theme.conflict);
  const hasSplit = Boolean(theme.missionSetup && theme.missionTask);

  return (
    <div className="rounded-xl overflow-hidden border border-slate-600/50">
      {/* Conflict badge */}
      {hasConflict && (
        <div className="bg-amber-900/30 border-b border-amber-800/30 px-4 py-2 flex items-center gap-2">
          <span className="text-amber-400 text-xs">⚡</span>
          <span className="text-xs text-amber-300 font-medium">{theme.conflict}</span>
        </div>
      )}

      {/* Mission text */}
      <div className="bg-slate-700/40 px-4 py-3 space-y-2">
        {hasSplit ? (
          <>
            <p className="text-sm text-slate-100 leading-relaxed font-medium">{theme.missionSetup}</p>
            <p className="text-sm text-slate-300 leading-relaxed">{theme.missionTask}</p>
          </>
        ) : (
          <p className="text-sm text-slate-200 leading-relaxed">
            {theme.mission || theme.themePtBr}
          </p>
        )}

        {/* Objective tag */}
        {theme.objective && (
          <div className="pt-1">
            <span className="text-xs text-slate-500">Objetivo: </span>
            <span className="text-xs text-slate-400">{theme.objective}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Shared components ─────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-slate-500 font-medium uppercase tracking-wider">{title}</p>
      {children}
    </div>
  );
}

function ResponseExamplesSection({ examples }: { examples: ResponseExample[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-1.5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full text-left"
      >
        <p className="text-xs text-slate-500 font-medium uppercase tracking-wider">
          Exemplos de resposta
        </p>
        <span className="text-slate-600 text-xs">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="space-y-3">
          <p className="text-xs text-slate-600 italic">
            Apenas inspiração — use outro contexto, não copie.
          </p>
          {examples.map((ex, i) => (
            <div key={i} className="rounded-lg bg-slate-700/30 border border-slate-600/30 px-3 py-3 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="px-1.5 py-0.5 rounded bg-blue-900/60 text-blue-300 text-xs font-bold">
                  {ex.level}
                </span>
                {ex.note && (
                  <span className="text-xs text-slate-500 italic">{ex.note}</span>
                )}
              </div>
              <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap">{ex.text}</p>
            </div>
          ))}
        </div>
      )}
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
