import { useState, useEffect } from 'react';
import { Target, Clock, Zap, Check, Info, Lock } from 'lucide-react';
import { EnglishDailyTheme, ResponseExample } from '../types';
import { fetchEnglishReviews } from '../lib/reviewsHistory';
import { buildLearningContextForTheme } from '../lib/themeContext';
import { fetchLearningMemory } from '../lib/learningMemory';
import { getAuthHeader } from '../lib/apiAuth';
import { apiUrl } from '../lib/apiUrl';
import { buildGenerateThemeRequestBody } from '../lib/dailyThemeRequest';
import { visibleVocabulary } from '../domain/writing/mission-vocabulary';
import type { WritingEntitlements } from '../domain/entitlements/entitlement-types';
import { formatDailyRemaining } from '../domain/entitlements/entitlement-formatting';
import { ENTITLEMENT_MESSAGES } from '../domain/entitlements/entitlement-messages';
import GrammarHelpModal from './GrammarHelpModal';

type GenState = 'idle' | 'loading' | 'error';

interface Props {
  theme: EnglishDailyTheme | null;
  /**
   * A previously-assigned mission was RESTORED (mount-only retrieve). This only
   * re-hydrates the mission on screen; it must NOT reset the writing surface,
   * because the day's stored writing/review belongs to this exact mission.
   */
  onThemeReady: (theme: EnglishDailyTheme) => void;
  /**
   * A genuinely NEW mission was just generated (re-roll or first generation).
   * The new mission has its own identity, so the caller must reset the writing/
   * review surface — nothing from the previous mission may leak into it.
   */
  onMissionGenerated: (theme: EnglishDailyTheme) => void;
  onStartWriting: () => void;
  /** null while the plan is still resolving — never treat as "available" during that window. */
  writingEntitlements: WritingEntitlements | null;
  /** Label for the primary "accept mission / start writing" action. Defaults to
   *  "Aceitar missão"; the guided flow passes "Começar escrita". */
  startLabel?: string;
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

export default function DailyThemeCard({ theme, onThemeReady, onMissionGenerated, onStartWriting, writingEntitlements, startLabel }: Props) {
  const [genState, setGenState] = useState<GenState>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [currentThemeId, setCurrentThemeId] = useState<string | null>(null);
  const [grammarModal, setGrammarModal] = useState<string | null>(null);
  // True while we ask the server whether today's mission already exists, so the
  // "no mission / generations exhausted" UI never flashes before the restore.
  const [restoring, setRestoring] = useState(theme === null);
  const isLoading = genState === 'loading';

  // Restore today's already-assigned mission on entry. The mission is persisted
  // server-side (generated_themes); the client used to keep it only in memory,
  // so leaving and coming back lost it while the generation still counted —
  // showing "você já usou todas as gerações" with no mission to continue. This
  // read-only call makes NO AI request and never consumes a generation. Runs
  // once on mount; if a mission is already loaded (e.g. just generated) it skips.
  useEffect(() => {
    if (theme !== null) { setRestoring(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const authHeader = await getAuthHeader();
        const res = await fetch(apiUrl('/api/generate-theme'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: JSON.stringify({ mode: 'retrieve' }),
        });
        if (!res.ok) return; // best-effort: fall back to the normal generate UI
        const data = await res.json();
        if (cancelled || !data?.theme) return;
        onThemeReady({ ...(data.theme as EnglishDailyTheme), id: data.themeId ?? undefined });
        setCurrentThemeId(data.themeId ?? null);
      } catch {
        // network hiccup → leave the normal generate UI; never blocks the screen
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => { cancelled = true; };
    // Mount-only: the restore is a one-shot on entry, not re-run when props change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const entitlementsLoading = writingEntitlements === null;
  const disabledByPlan = writingEntitlements ? !writingEntitlements.enabled : false;
  const generationsLimit = writingEntitlements?.themeGenerations ?? null;
  const generationsBlocked = generationsLimit ? !generationsLimit.canStart : false;
  const generateDisabled = isLoading || entitlementsLoading || disabledByPlan || generationsBlocked;

  const remainingLabel = !generationsLimit
    ? null
    : generationsLimit.unlimited
    ? ENTITLEMENT_MESSAGES.unlimitedLabel
    : formatDailyRemaining(generationsLimit.remaining, 'geração', 'gerações');

  async function generate() {
    // Frontend guard for UX only — the backend re-checks this immediately
    // before calling the AI, which is the actual source of truth.
    if (entitlementsLoading || disabledByPlan || generationsBlocked) return;

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
      // A Escrita é sempre uma Escrita normal — nunca consultamos revisão
      // pendente para sequestrar a missão. Os erros viram cards na atividade
      // independente "Revisar meus erros".
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

      const authHeader = await getAuthHeader();
      // The student does NOT choose a theme: the mission is determined
      // exclusively by the day's pedagogical recorte. No user-selected theme is
      // sent to the backend.
      const requestBody = buildGenerateThemeRequestBody({
        mode: 'normal',
        reviewGroup: null,
        learningContext: context,
        previousThemeId: currentThemeId,
        excludedTheme,
      });
      const res = await fetch(apiUrl('/api/generate-theme'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify(requestBody),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? data.error ?? 'Erro ao gerar missão');

      // Carry the persisted generated_theme id ON the theme so the review can
      // bind the writing to the EXACT mission it was generated for (blocker 2),
      // instead of the server guessing "the latest theme". This is a NEW mission,
      // so it goes through onMissionGenerated (resets the writing surface) — never
      // onThemeReady, which is restore-only and would keep the previous text.
      onMissionGenerated({ ...(data.theme as EnglishDailyTheme), id: data.themeId ?? undefined });
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
        <Target className="w-4 h-4 shrink-0 text-slate-300" strokeWidth={2} aria-hidden="true" />
        <p className="text-sm font-semibold text-slate-100">Missão do dia</p>
      </div>

      {/* Loading (generating a new mission, or restoring today's on entry) */}
      {(isLoading || (restoring && !theme)) && (
        <div className="px-4 pb-6 flex flex-col items-center gap-3 py-4">
          <div className="w-7 h-7 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-xs text-slate-400">{isLoading ? 'Criando sua missão...' : 'Carregando sua missão...'}</p>
        </div>
      )}

      {/* No theme yet (only after the restore attempt settled) */}
      {!theme && !isLoading && !restoring && (
        <div className="px-4 pb-4 space-y-3">
          {disabledByPlan ? (
            <p className="text-xs text-amber-400 flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
              {ENTITLEMENT_MESSAGES.featureUnavailable}
            </p>
          ) : generationsBlocked ? (
            <p className="text-xs text-amber-400">{ENTITLEMENT_MESSAGES.writingGenerationsExhausted}</p>
          ) : genState === 'error' ? (
            <p className="text-xs text-red-400">
              {errorMsg || 'Não foi possível gerar a missão. Tente novamente.'}
            </p>
          ) : (
            <p className="text-xs text-slate-400">
              A IA cria uma missão do seu plano de ensino, focada no recorte atual do currículo. Cada missão é uma situação real para resolver.
            </p>
          )}
          <button
            onClick={generate}
            disabled={generateDisabled}
            aria-disabled={generateDisabled}
            className="w-full py-2.5 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {genState === 'error' ? 'Tentar novamente' : 'Receber missão'}
          </button>
          {remainingLabel && !disabledByPlan && !generationsBlocked && (
            <p className="text-xs text-slate-500 text-center">{remainingLabel}</p>
          )}
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
            <span className="flex items-center gap-1 text-xs text-slate-500">
              <Clock className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
              {theme.estimatedTimeMinutes} min
            </span>
          </div>

          {/* Title */}
          <p className="text-base font-bold text-slate-100">{theme.title}</p>

          {/* Mission card — the centerpiece */}
          <MissionCard theme={theme} />

          {/* English command */}
          {theme.themeEn && (
            <p className="text-sm text-blue-300 font-medium italic">{theme.themeEn}</p>
          )}

          {/* Why this activity / pedagogical reason */}
          {(theme.whyThisActivity || theme.pedagogicalReason) && (
            <p className="text-xs text-slate-500 italic leading-relaxed">
              {theme.whyThisActivity || theme.pedagogicalReason}
            </p>
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
                      className="w-5 h-5 flex items-center justify-center rounded-full text-slate-500 hover:text-slate-300 hover:bg-slate-700 transition-colors"
                      aria-label={`Explicação de ${g}`}
                      title={`Ver explicação de ${g}`}
                    >
                      <Info className="w-3.5 h-3.5 shrink-0" strokeWidth={2} />
                    </button>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Suggested vocabulary — filtered to items with real content so the
             heading never renders over an empty/blank AI-generated list. */}
          {visibleVocabulary(theme.suggestedVocabulary).length > 0 && (
            <Section title="Vocabulário útil para esta missão">
              <div className="space-y-2">
                {visibleVocabulary(theme.suggestedVocabulary).map((v, i) => (
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

          {/* The second, redundant support-vocabulary chip section was removed:
             it duplicated the "Vocabulário útil para esta missão" section above
             (both are optional support vocabulary). The underlying field stays in
             the data model (mission snapshot + conversation context); only its
             duplicate on-screen section is gone. */}

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
                    <Check className="w-3.5 h-3.5 shrink-0 text-green-500 mt-0.5" strokeWidth={2} aria-hidden="true" />
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

          {/* Blocked-generation message — the current mission stays fully usable either way */}
          {!disabledByPlan && generationsBlocked && (
            <p className="text-xs text-amber-400">{ENTITLEMENT_MESSAGES.writingGenerationsExhausted}</p>
          )}

          {/* Action buttons */}
          <div className="flex flex-col gap-1.5 pt-1">
            <div className="flex gap-2">
              <button
                onClick={generate}
                disabled={generateDisabled}
                aria-disabled={generateDisabled}
                title={generationsBlocked ? ENTITLEMENT_MESSAGES.writingGenerationsExhausted : undefined}
                className="flex-1 py-2.5 rounded-xl text-xs font-medium text-slate-400 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Outra missão
              </button>
              <button
                onClick={onStartWriting}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors"
              >
                {startLabel ?? 'Aceitar missão'}
              </button>
            </div>
            {remainingLabel && !disabledByPlan && !generationsBlocked && (
              <p className="text-xs text-slate-500 text-center">{remainingLabel}</p>
            )}
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
          <Zap className="w-3.5 h-3.5 shrink-0 text-amber-400" strokeWidth={2} aria-hidden="true" />
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
