import { useState, useEffect, useRef, useCallback } from 'react';
import { GraduationCap, ArrowRight, Clock, CheckCircle2, XCircle } from 'lucide-react';
import { AppIcon } from '../AppIcon';
import {
  getPlacementState,
  startPlacement,
  submitPlacementAnswer,
  skipPlacement,
  submitPlacementC2,
  evaluatePendingPlacementC2,
  type PlacementState,
  type PlacementQuestionView,
  type PlacementAnswerFeedback,
} from '../../lib/placementApi';

/** Snapshot of the answered question + its server-checked feedback (one-shot screen). */
interface AnswerFeedbackScreen {
  question: PlacementQuestionView;
  feedback: PlacementAnswerFeedback;
}

interface Props {
  /** Called after the user skips or finishes (App refreshes status + leaves). */
  onFinished: () => void;
  /** Optional back (menu entry only). Absent in the forced post-signup gate. */
  onExit?: () => void;
}

function copyOf(state: PlacementState | null, key: string, fallback: string): string {
  return state?.copy?.[key] ?? fallback;
}

export default function PlacementOnboarding({ onFinished, onExit }: Props) {
  const [state, setState] = useState<PlacementState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [answerFeedback, setAnswerFeedback] = useState<AnswerFeedbackScreen | null>(null);
  const [c2Text, setC2Text] = useState('');
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const pendingTriedRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setState(await getPlacementState());
      setError(null);
    } catch {
      setError('Não foi possível carregar o teste. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Reset per-question local state whenever the served screen changes.
  const screen = state?.screen;
  const questionKey = state?.question?.questionKey;
  const c2Step = state?.c2?.stepKey;
  useEffect(() => { setSelected(null); }, [questionKey]);
  useEffect(() => {
    setC2Text('');
    setTimeLeft(state?.c2?.timeLimitSeconds ?? null);
  }, [c2Step, state?.c2?.timeLimitSeconds]);

  async function run(fn: () => Promise<PlacementState>) {
    setBusy(true);
    setError(null);
    try {
      setState(await fn());
    } catch {
      setError('Algo deu errado. Tente novamente.');
    } finally {
      setBusy(false);
    }
  }

  const handleSkip = () => run(async () => { const s = await skipPlacement(); onFinished(); return s; });

  // Submit one objective answer. The server records it and returns the NEXT
  // screen with `answerFeedback` for the question just answered — we hold that
  // feedback as a one-shot screen and only reveal the next screen on "Continuar".
  const handleConfirm = async () => {
    if (busy || !selected || !state?.attemptId || !state.question) return;
    const answered = state.question;
    const chosen = selected;
    setBusy(true);
    setError(null);
    try {
      const next = await submitPlacementAnswer(state.attemptId, answered.questionKey, chosen);
      if (next.answerFeedback && next.answerFeedback.questionKey === answered.questionKey) {
        setAnswerFeedback({ question: answered, feedback: next.answerFeedback });
      }
      setState(next);
    } catch {
      setError('Algo deu errado. Tente novamente.');
    } finally {
      setBusy(false);
    }
  };

  const submitC2 = useCallback((text: string) => {
    if (!state?.attemptId || !state.c2) return;
    run(() => submitPlacementC2(state.attemptId as string, state.c2!.stepKey, text));
  }, [state?.attemptId, state?.c2]);

  // C2 countdown — when it hits 0 the current text is submitted as-is (never a
  // crash, never lost). Re-armed on each new step by the reset effect above.
  useEffect(() => {
    // Paused while an answer-feedback screen overlays the (already-advanced) c2 gate.
    if (screen !== 'c2_gate' || timeLeft === null || answerFeedback) return;
    if (timeLeft <= 0) { submitC2(c2Text); return; }
    const id = setTimeout(() => setTimeLeft((t) => (t === null ? null : t - 1)), 1000);
    return () => clearTimeout(id);
  }, [screen, timeLeft, c2Text, submitC2, answerFeedback]);

  // Auto-retry a pending C2 evaluation once on entry.
  useEffect(() => {
    if (screen !== 'pending' || pendingTriedRef.current) return;
    pendingTriedRef.current = true;
    run(() => evaluatePendingPlacementC2());
  }, [screen]);

  // ── Shared chrome ──────────────────────────────────────────────────────────
  const SkipButton = (
    <button
      onClick={handleSkip}
      disabled={busy}
      className="text-sm text-slate-400 hover:text-slate-200 underline underline-offset-2 disabled:opacity-50"
    >
      {copyOf(state, 'cta_skip', 'Pular teste')}
    </button>
  );

  const Shell = ({ children, showSkip }: { children: React.ReactNode; showSkip: boolean }) => (
    <div
      className="min-h-screen bg-slate-900 text-slate-100 flex flex-col"
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex items-center justify-between px-4 h-14 shrink-0">
        <div className="flex items-center gap-2 text-slate-300">
          <AppIcon icon={GraduationCap} className="w-5 h-5" />
          <span className="text-sm font-semibold">Teste de nível</span>
        </div>
        {showSkip ? SkipButton : onExit ? (
          <button onClick={onExit} disabled={busy} className="text-sm text-slate-400 hover:text-slate-200">Fechar</button>
        ) : <span />}
      </div>
      <div className="flex-1 overflow-auto px-5 pb-8 flex flex-col">{children}</div>
    </div>
  );

  const ProgressBar = ({ value }: { value: number }) => (
    <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden mb-6">
      <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${Math.round(Math.max(0.05, Math.min(1, value)) * 100)}%` }} />
    </div>
  );

  if (loading) {
    return (
      <Shell showSkip={false}>
        <div className="flex-1 flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      </Shell>
    );
  }

  // ── Answer feedback (one-shot, after each objective answer) ─────────────────
  if (answerFeedback) {
    const { question: fq, feedback: fb } = answerFeedback;
    return (
      <Shell showSkip={false}>
        <div className="flex-1 flex flex-col max-w-md mx-auto w-full pt-2">
          <div
            className={`flex items-center gap-2 mb-5 ${fb.isCorrect ? 'text-emerald-400' : 'text-rose-400'}`}
          >
            <AppIcon icon={fb.isCorrect ? CheckCircle2 : XCircle} className="w-6 h-6" />
            <span className="text-lg font-bold">
              {fb.isCorrect
                ? copyOf(state, 'feedback_correct_title', 'Você acertou!')
                : copyOf(state, 'feedback_incorrect_title', 'Resposta incorreta')}
            </span>
          </div>
          {fq.context && <p className="text-slate-400 text-sm mb-3">{fq.context}</p>}
          <p className="text-base text-slate-100 font-medium whitespace-pre-line mb-5">{fq.stem}</p>
          <div className="space-y-3">
            {fq.options.map((opt) => {
              const isCorrectOpt = opt.key === fb.correctOptionKey;
              const isWrongPick = opt.key === fb.selectedOptionKey && !fb.isCorrect;
              const base = 'w-full flex items-center gap-2 text-left px-4 py-3.5 rounded-xl border text-sm';
              const cls = isCorrectOpt
                ? 'border-emerald-500 bg-emerald-600/15 text-emerald-100'
                : isWrongPick
                  ? 'border-rose-500 bg-rose-600/15 text-rose-100'
                  : 'border-slate-700 bg-slate-800 text-slate-400';
              return (
                <div key={opt.key} className={`${base} ${cls}`}>
                  {isCorrectOpt && <AppIcon icon={CheckCircle2} className="w-4 h-4 shrink-0 text-emerald-400" />}
                  {isWrongPick && <AppIcon icon={XCircle} className="w-4 h-4 shrink-0 text-rose-400" />}
                  <span className="flex-1">{opt.label}</span>
                </div>
              );
            })}
          </div>
          {!fb.isCorrect && (
            <p className="text-slate-300 text-sm mt-4">
              {copyOf(state, 'feedback_correct_label', 'Resposta correta')}:{' '}
              <span className="text-emerald-300 font-medium">{fb.correctOptionLabel}</span>
            </p>
          )}
          <div className="mt-auto pt-6">
            <button
              onClick={() => setAnswerFeedback(null)}
              className="w-full py-3.5 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white flex items-center justify-center gap-2"
            >
              {copyOf(state, 'cta_continue', 'Continuar')}
              <AppIcon icon={ArrowRight} className="w-4 h-4" />
            </button>
          </div>
        </div>
      </Shell>
    );
  }

  // ── Intro ──────────────────────────────────────────────────────────────────
  if (screen === 'intro') {
    return (
      <Shell showSkip>
        <div className="flex-1 flex flex-col justify-center max-w-md mx-auto w-full">
          <div className="w-14 h-14 rounded-2xl bg-blue-600/20 flex items-center justify-center mb-6">
            <AppIcon icon={GraduationCap} className="w-7 h-7 text-blue-400" />
          </div>
          <h1 className="text-2xl font-bold text-slate-100 mb-3">
            {copyOf(state, 'onboarding_title', 'Descubra seu nível')}
          </h1>
          <p className="text-slate-400 text-sm leading-relaxed mb-8">
            {copyOf(state, 'onboarding_subtitle', 'Responda algumas perguntas rápidas para começarmos no ponto mais adequado para você.')}
          </p>
          {error && <p className="text-amber-300 text-sm mb-4">{error}</p>}
          <button
            onClick={() => run(startPlacement)}
            disabled={busy}
            className="w-full py-3.5 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {copyOf(state, 'cta_start', 'Começar teste')}
            <AppIcon icon={ArrowRight} className="w-4 h-4" />
          </button>
          <div className="mt-4 text-center">{SkipButton}</div>
        </div>
      </Shell>
    );
  }

  // ── Objective question ─────────────────────────────────────────────────────
  if (screen === 'question' && state?.question) {
    const q = state.question;
    return (
      <Shell showSkip>
        <div className="flex-1 flex flex-col max-w-md mx-auto w-full pt-2">
          <ProgressBar value={q.progress} />
          {q.context && <p className="text-slate-400 text-sm mb-3">{q.context}</p>}
          <p className="text-lg text-slate-100 font-medium whitespace-pre-line mb-6">{q.stem}</p>
          <div className="space-y-3">
            {q.options.map((opt) => (
              <button
                key={opt.key}
                onClick={() => setSelected(opt.key)}
                disabled={busy}
                className={`w-full text-left px-4 py-3.5 rounded-xl border text-sm transition-all ${
                  selected === opt.key
                    ? 'border-blue-500 bg-blue-600/15 text-white'
                    : 'border-slate-700 bg-slate-800 text-slate-200 hover:border-slate-600'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {error && <p className="text-amber-300 text-sm mt-4">{error}</p>}
          <div className="mt-auto pt-6">
            <button
              onClick={handleConfirm}
              disabled={busy || !selected}
              className="w-full py-3.5 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40"
            >
              Confirmar
            </button>
            <div className="mt-3 text-center">{SkipButton}</div>
          </div>
        </div>
      </Shell>
    );
  }

  // ── C2 gate (open response + timer) ────────────────────────────────────────
  if (screen === 'c2_gate' && state?.c2) {
    const c2 = state.c2;
    return (
      <Shell showSkip>
        <div className="flex-1 flex flex-col max-w-md mx-auto w-full pt-2">
          <ProgressBar value={c2.progress} />
          <p className="text-slate-400 text-sm mb-3">{copyOf(state, 'c2_intro', 'Tarefa de escrita. Responda dentro do tempo indicado.')}</p>
          <p className="text-lg text-slate-100 font-medium whitespace-pre-line mb-4">{c2.stem}</p>
          <div className="flex items-center gap-2 text-sm mb-2">
            <AppIcon icon={Clock} className={`w-4 h-4 ${timeLeft !== null && timeLeft <= 10 ? 'text-amber-400' : 'text-slate-400'}`} />
            <span className={timeLeft !== null && timeLeft <= 10 ? 'text-amber-400' : 'text-slate-400'}>
              {timeLeft ?? c2.timeLimitSeconds}s
            </span>
          </div>
          <textarea
            value={c2Text}
            onChange={(e) => setC2Text(e.target.value)}
            disabled={busy}
            rows={5}
            placeholder="Write your answer in English..."
            className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-100 focus:border-blue-500 focus:outline-none resize-none"
          />
          {error && <p className="text-amber-300 text-sm mt-3">{error}</p>}
          <div className="mt-auto pt-6">
            <button
              onClick={() => submitC2(c2Text)}
              disabled={busy}
              className="w-full py-3.5 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50"
            >
              Enviar
            </button>
            <div className="mt-3 text-center">{SkipButton}</div>
          </div>
        </div>
      </Shell>
    );
  }

  // ── Result ─────────────────────────────────────────────────────────────────
  if ((screen === 'result' || screen === 'done') && state?.result) {
    const r = state.result;
    return (
      <Shell showSkip={false}>
        <div className="flex-1 flex flex-col justify-center max-w-md mx-auto w-full">
          <div className="w-14 h-14 rounded-2xl bg-emerald-600/20 flex items-center justify-center mb-6">
            <AppIcon icon={GraduationCap} className="w-7 h-7 text-emerald-400" />
          </div>
          <h1 className="text-2xl font-bold text-slate-100 mb-3">{r.headline}</h1>
          <p className="text-slate-400 text-sm leading-relaxed mb-8">{r.body}</p>
          <button
            onClick={onFinished}
            className="w-full py-3.5 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white flex items-center justify-center gap-2"
          >
            {r.cta}
            <AppIcon icon={ArrowRight} className="w-4 h-4" />
          </button>
        </div>
      </Shell>
    );
  }

  // ── Pending evaluation (AI temporarily unavailable) ────────────────────────
  if (screen === 'pending') {
    return (
      <Shell showSkip={false}>
        <div className="flex-1 flex flex-col justify-center max-w-md mx-auto w-full">
          <h1 className="text-xl font-bold text-slate-100 mb-3">{copyOf(state, 'pending_title', 'Estamos avaliando suas respostas')}</h1>
          <p className="text-slate-400 text-sm leading-relaxed mb-8">{copyOf(state, 'pending_body', 'Você já pode usar o app normalmente. Vamos concluir sua avaliação em instantes.')}</p>
          <button onClick={onFinished} className="w-full py-3.5 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white">
            Continuar
          </button>
        </div>
      </Shell>
    );
  }

  // Fallback (unknown/config error) — never trap the user.
  return (
    <Shell showSkip={false}>
      <div className="flex-1 flex flex-col justify-center max-w-md mx-auto w-full">
        <p className="text-slate-400 text-sm mb-6">{error ?? 'Teste de nível indisponível no momento.'}</p>
        <button onClick={onFinished} className="w-full py-3.5 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white">
          Continuar
        </button>
      </div>
    </Shell>
  );
}
