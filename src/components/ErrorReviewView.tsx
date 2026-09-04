import { useEffect, useRef, useState } from 'react';
import { trackActivityCompleted } from '../lib/analytics/appsFlyerEvents';
import { useCelebration } from '../celebration';
import {
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Sparkles,
  RefreshCw,
  ScanLine,
  Lightbulb,
  Check,
  X,
  ArrowRight,
} from 'lucide-react';
import ScreenHeader from './ScreenHeader';
import {
  fetchErrorReviewSession,
  submitErrorReviewItem,
  ErrorReviewItem,
} from '../lib/errorReview';
import { normalizeAnswer } from '../domain/error-review/answer-check';
import { buildResultView, ErrorReviewResultView } from '../domain/error-review/result-view';

interface Props {
  onBack: () => void;
}

type Phase = 'loading' | 'error' | 'empty' | 'active' | 'done';

export default function ErrorReviewView({ onBack }: Props) {
  const celebration = useCelebration();
  const [phase, setPhase] = useState<Phase>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [items, setItems] = useState<ErrorReviewItem[]>([]);
  const [index, setIndex] = useState(0);

  // Múltipla escolha: guardamos a alternativa selecionada por ÍNDICE (a resposta
  // enviada ao servidor é o TEXTO dessa alternativa). Nunca há textarea.
  const [selected, setSelected] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<ErrorReviewResultView | null>(null);

  async function load() {
    setPhase('loading');
    setLoadError(null);
    try {
      const session = await fetchErrorReviewSession();
      if (session.items.length === 0) {
        setPhase('empty');
        return;
      }
      setItems(session.items);
      setIndex(0);
      setSelected(null);
      setResult(null);
      setSubmitError(null);
      setPhase('active');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Erro ao carregar');
      setPhase('error');
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = items[index];
  const total = items.length;

  // Always-fresh id of the card currently on screen, read at async-resolve time
  // to drop a late response meant for a card the user already left.
  const currentItemIdRef = useRef<string | undefined>(undefined);
  useEffect(() => { currentItemIdRef.current = current?.id; }, [current]);

  function handleSelect(i: number) {
    // Trava a troca de alternativa durante o envio e depois do resultado.
    if (submitting || result) return;
    setSelected(i);
  }

  async function handleVerify() {
    if (!current || selected === null || submitting || result) return;
    const submittedAnswer = current.choices[selected];
    if (!submittedAnswer) return;
    setSubmitting(true);
    setSubmitError(null);
    // Snapshot the EXACT item this submission is for, BEFORE any await, so the
    // result binds to the right card even if the current item later changes.
    const submittedItemId = current.id;
    try {
      const res = await submitErrorReviewItem(submittedItemId, submittedAnswer);
      // Genuine review completion (a review_item_attempts row was written) —
      // AppsFlyer funnel. Fire-and-forget & fail-safe; the server-authoritative
      // claim RPC de-dupes first-activity / per-day, so per-answer calls are safe.
      void trackActivityCompleted('review');
      // Drop a stale / out-of-order response for a card the user already left.
      const view = buildResultView(res, submittedAnswer, submittedItemId, currentItemIdRef.current);
      if (view) setResult(view);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro ao verificar';
      // A concurrent day-limit change is the one case worth explaining plainly.
      setSubmitError(msg === 'DAILY_LIMIT_REACHED'
        ? 'Você atingiu o limite de revisões de hoje.'
        : 'Não foi possível verificar sua resposta. Tente novamente.');
    } finally {
      setSubmitting(false);
    }
  }

  function handleContinue() {
    const next = index + 1;
    if (next >= total) {
      setPhase('done');
      // Session finished (every item's answer was server-persisted per-item).
      // Review is optional — this only ever shows the individual celebration.
      if (total > 0) celebration.notifyActivityCompleted('review');
      return;
    }
    setIndex(next);
    setSelected(null);
    setResult(null);
    setSubmitError(null);
  }

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      <ScreenHeader
        onBack={onBack}
        title="Revisar meus erros"
        subtitle={phase === 'active' ? `${index + 1} de ${total}` : undefined}
      />

      {phase === 'active' && total > 0 && (
        <div className="px-4 pt-3 max-w-lg mx-auto w-full">
          <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-blue-500 to-blue-400 transition-all duration-500 ease-out"
              style={{ width: `${((index + 1) / total) * 100}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto p-4 max-w-lg mx-auto w-full">
        {phase === 'loading' && (
          <div className="bg-slate-800 rounded-xl p-8 text-center space-y-3 mt-6">
            <Loader2 className="w-8 h-8 text-blue-400/70 shrink-0 animate-spin mx-auto" strokeWidth={2} aria-hidden="true" />
            <p className="text-slate-300 text-sm">Carregando seus erros...</p>
          </div>
        )}

        {phase === 'error' && (
          <div className="bg-red-900/30 border border-red-800 rounded-xl p-5 space-y-3 mt-6">
            <p className="text-red-300 text-sm font-medium">Erro ao carregar a revisão</p>
            {loadError && <p className="text-red-400 text-xs break-words">{loadError}</p>}
            <button
              onClick={load}
              className="inline-flex items-center gap-2 text-xs text-slate-300 hover:text-white transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
              Tentar novamente
            </button>
          </div>
        )}

        {phase === 'empty' && <EmptyState />}

        {phase === 'done' && <DoneState onBack={onBack} />}

        {phase === 'active' && current && (
          <QuestionCard
            // Remonta a cada item: evita que a transição de cor (correta/errada)
            // do item anterior "vaze" para os cards do próximo (mesmos nós DOM).
            key={current.id}
            item={current}
            selected={selected}
            onSelect={handleSelect}
            submitting={submitting}
            submitError={submitError}
            result={result}
            onVerify={handleVerify}
            onContinue={handleContinue}
            isLast={index + 1 >= total}
          />
        )}
      </div>
    </div>
  );
}

// ── Question + choices (single unified screen, pre- and post-verify) ───────────

function QuestionCard({
  item,
  selected,
  onSelect,
  submitting,
  submitError,
  result,
  onVerify,
  onContinue,
  isLast,
}: {
  item: ErrorReviewItem;
  selected: number | null;
  onSelect: (i: number) => void;
  submitting: boolean;
  submitError: string | null;
  result: ErrorReviewResultView | null;
  onVerify: () => void;
  onContinue: () => void;
  isLast: boolean;
}) {
  const answered = result !== null;
  const correctNorm = answered ? normalizeAnswer(result!.correctedValue) : null;

  return (
    <div className="mt-4 space-y-5">
      {/* ── "Você escreveu" — o erro sob revisão ── */}
      <div className="rounded-2xl p-4 flex items-center gap-3.5 bg-red-500/5 border border-red-500/25">
        <div className="w-11 h-11 rounded-full bg-red-500/15 flex items-center justify-center shrink-0">
          <X className="w-5 h-5 text-red-400" strokeWidth={2.5} aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <p className="text-[11px] text-red-400/90 uppercase tracking-wider font-semibold">Você escreveu</p>
          <p className="text-red-200 text-lg font-semibold leading-snug break-words">"{item.originalValue}"</p>
          {item.originalSentence && (
            <p className="text-xs text-slate-500 italic mt-1 break-words">Na frase: "{item.originalSentence}"</p>
          )}
        </div>
      </div>

      {/* ── Pergunta ── */}
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl bg-blue-500/15 flex items-center justify-center shrink-0 mt-0.5">
          <ScanLine className="w-5 h-5 text-blue-400" strokeWidth={2} aria-hidden="true" />
        </div>
        <div>
          <p className="text-slate-100 text-base font-semibold leading-tight">Qual é a forma correta?</p>
          <p className="text-slate-500 text-sm mt-0.5">
            {answered ? 'Veja o resultado abaixo.' : 'Toque na opção correta abaixo.'}
          </p>
        </div>
      </div>

      {/* ── Alternativas ── */}
      <div className="space-y-3" role="radiogroup" aria-label="Alternativas">
        {item.choices.map((choice, i) => (
          <ChoiceButton
            key={i}
            choice={choice}
            index={i}
            isSelected={selected === i}
            answered={answered}
            isCorrect={answered ? normalizeAnswer(choice) === correctNorm : false}
            disabled={submitting || answered}
            onSelect={onSelect}
          />
        ))}
      </div>

      {/* ── Feedback (só depois do submit — o backend é a fonte da verdade) ── */}
      {answered && <ResultFeedback result={result!} />}

      {submitError && <p className="text-xs text-amber-400 text-center">{submitError}</p>}

      {/* ── Ação primária ── */}
      {!answered ? (
        <PrimaryButton
          onClick={onVerify}
          disabled={selected === null || submitting}
          loading={submitting}
        >
          Verificar
        </PrimaryButton>
      ) : (
        <PrimaryButton onClick={onContinue} trailingIcon>
          {isLast ? 'Concluir' : 'Continuar'}
        </PrimaryButton>
      )}
    </div>
  );
}

// ── One choice card ────────────────────────────────────────────────────────────

function ChoiceButton({
  choice,
  index,
  isSelected,
  answered,
  isCorrect,
  disabled,
  onSelect,
}: {
  choice: string;
  index: number;
  isSelected: boolean;
  answered: boolean;
  isCorrect: boolean;
  disabled: boolean;
  onSelect: (i: number) => void;
}) {
  // Estado visual:
  //  - antes de responder: normal / selecionado (azul).
  //  - depois: correta (verde, sempre destacada) / escolhida-e-errada (vermelho)
  //    / demais (apagadas).
  const showCorrect = answered && isCorrect;
  const showWrong = answered && isSelected && !isCorrect;

  let container =
    'border-slate-700/70 bg-slate-800/40 hover:border-slate-600 hover:bg-slate-800/70';
  if (showCorrect) {
    container = 'border-green-500/70 bg-green-500/10';
  } else if (showWrong) {
    container = 'border-red-500/70 bg-red-500/10';
  } else if (answered) {
    container = 'border-slate-800 bg-slate-800/20 opacity-60';
  } else if (isSelected) {
    container = 'border-blue-500 bg-blue-500/10 ring-1 ring-blue-500/40';
  }

  return (
    <button
      type="button"
      role="radio"
      aria-checked={isSelected}
      disabled={disabled}
      onClick={() => onSelect(index)}
      className={`w-full flex items-center gap-3.5 rounded-2xl border p-4 text-left transition-all
        focus:outline-none focus:ring-2 focus:ring-blue-500/50
        disabled:cursor-default ${container}`}
    >
      <Indicator showCorrect={showCorrect} showWrong={showWrong} isSelected={isSelected} answered={answered} />
      <span className={`text-base font-medium break-words min-w-0 flex-1
        ${showCorrect ? 'text-green-100' : showWrong ? 'text-red-100' : 'text-slate-100'}`}>
        {choice}
      </span>
      {showCorrect && (
        <span className="shrink-0 text-[11px] font-semibold text-green-400 border border-green-500/40 rounded-md px-2 py-0.5">
          CORRETA
        </span>
      )}
    </button>
  );
}

function Indicator({
  showCorrect,
  showWrong,
  isSelected,
  answered,
}: {
  showCorrect: boolean;
  showWrong: boolean;
  isSelected: boolean;
  answered: boolean;
}) {
  if (showCorrect) {
    return (
      <span className="w-6 h-6 rounded-full bg-green-500 flex items-center justify-center shrink-0">
        <Check className="w-4 h-4 text-white" strokeWidth={3} aria-hidden="true" />
      </span>
    );
  }
  if (showWrong) {
    return (
      <span className="w-6 h-6 rounded-full bg-red-500 flex items-center justify-center shrink-0">
        <X className="w-4 h-4 text-white" strokeWidth={3} aria-hidden="true" />
      </span>
    );
  }
  const ring = isSelected && !answered ? 'border-blue-400' : 'border-slate-600';
  return (
    <span className={`w-6 h-6 rounded-full border-2 ${ring} flex items-center justify-center shrink-0`}>
      {isSelected && !answered && <span className="w-2.5 h-2.5 rounded-full bg-blue-400" />}
    </span>
  );
}

// ── Result banner + explanation (integrated with the choices) ──────────────────

function ResultFeedback({ result }: { result: ErrorReviewResultView }) {
  const passed = result.passed;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {passed
          ? <CheckCircle2 className="w-5 h-5 shrink-0 text-green-400" strokeWidth={2} aria-hidden="true" />
          : <AlertTriangle className="w-5 h-5 shrink-0 text-amber-400" strokeWidth={2} aria-hidden="true" />}
        <p className={`text-base font-semibold ${passed ? 'text-green-300' : 'text-amber-300'}`}>
          {passed ? (result.mastered ? 'Dominado!' : 'Certo!') : 'Quase!'}
        </p>
      </div>

      {result.explanation && (
        <div className="rounded-2xl p-4 flex items-start gap-3.5 bg-blue-500/5 border border-blue-500/20">
          <div className="w-9 h-9 rounded-full bg-blue-500/15 flex items-center justify-center shrink-0">
            <Lightbulb className="w-5 h-5 text-blue-400" strokeWidth={2} aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-blue-300">Explicação</p>
            <p className="text-sm text-slate-300 leading-relaxed mt-0.5 break-words">{result.explanation}</p>
          </div>
        </div>
      )}

      {result.mastered && (
        <p className="text-xs text-green-400 flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
          Você dominou este erro. Ele não voltará mais para revisão.
        </p>
      )}
    </div>
  );
}

// ── Primary action button (gradient, matches the mockup) ───────────────────────

function PrimaryButton({
  onClick,
  disabled,
  loading,
  trailingIcon,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  trailingIcon?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full py-3.5 rounded-2xl text-base font-semibold text-white shadow-lg shadow-blue-900/30
        bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400
        disabled:from-slate-700 disabled:to-slate-700 disabled:text-slate-500 disabled:shadow-none
        disabled:cursor-not-allowed transition-all
        flex items-center justify-center gap-2"
    >
      {loading ? (
        <>
          <Loader2 className="w-5 h-5 shrink-0 animate-spin" strokeWidth={2} aria-hidden="true" />
          Verificando...
        </>
      ) : (
        <>
          {children}
          {trailingIcon && <ArrowRight className="w-5 h-5 shrink-0" strokeWidth={2} aria-hidden="true" />}
        </>
      )}
    </button>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="bg-slate-800 rounded-2xl p-8 text-center space-y-4 mt-6">
      <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-700 shadow-lg shadow-emerald-900/40 mx-auto">
        <CheckCircle2 className="w-7 h-7 text-white shrink-0" strokeWidth={2} aria-hidden="true" />
      </div>
      <div>
        <p className="text-base font-semibold text-slate-100">Tudo em dia</p>
        <p className="text-sm text-slate-400 mt-2 leading-relaxed">
          Continue praticando escrita. Novos erros importantes aparecerão aqui para revisão.
        </p>
      </div>
    </div>
  );
}

// ── Done state ────────────────────────────────────────────────────────────────

function DoneState({ onBack }: { onBack: () => void }) {
  return (
    <div className="bg-slate-800 rounded-2xl p-8 text-center space-y-4 mt-6">
      <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-500 to-blue-700 shadow-lg shadow-blue-900/40 mx-auto">
        <Sparkles className="w-7 h-7 text-white shrink-0" strokeWidth={2} aria-hidden="true" />
      </div>
      <div>
        <p className="text-base font-semibold text-slate-100">Revisão concluída!</p>
        <p className="text-sm text-slate-400 mt-2 leading-relaxed">
          Você revisou seus erros de hoje. Volte amanhã para reforçar o que ainda precisa de prática.
        </p>
      </div>
      <button
        onClick={onBack}
        className="px-5 py-2.5 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm font-medium transition-colors"
      >
        Voltar ao início
      </button>
    </div>
  );
}
