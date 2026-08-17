import { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, Loader2, Sparkles, RefreshCw } from 'lucide-react';
import {
  fetchErrorReviewSession,
  submitErrorReviewItem,
  ErrorReviewItem,
  ErrorReviewResult,
} from '../lib/errorReview';

interface Props {
  onBack: () => void;
}

type Phase = 'loading' | 'error' | 'empty' | 'active' | 'done';

export default function ErrorReviewView({ onBack }: Props) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [items, setItems] = useState<ErrorReviewItem[]>([]);
  const [index, setIndex] = useState(0);

  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<ErrorReviewResult | null>(null);

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
      setAnswer('');
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

  async function handleVerify() {
    if (!current || !answer.trim() || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await submitErrorReviewItem(current.id, answer);
      setResult(res);
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
      return;
    }
    setIndex(next);
    setAnswer('');
    setResult(null);
    setSubmitError(null);
  }

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      <header className="sticky top-0 bg-slate-800 border-b border-slate-700 px-4 py-3 flex items-center gap-3 z-10">
        <button onClick={onBack} className="text-slate-400 hover:text-slate-100 text-lg" aria-label="Voltar">←</button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-100 truncate">Revisar meus erros</p>
          {phase === 'active' && (
            <p className="text-xs text-slate-400">{index + 1} de {total}</p>
          )}
        </div>
      </header>

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
          <div className="mt-4 space-y-4">
            {!result ? (
              <>
                <div className="bg-slate-800 rounded-2xl p-5 space-y-3">
                  <p className="text-xs text-slate-500 uppercase tracking-wider font-medium">Você escreveu</p>
                  <p className="text-red-300 text-base italic leading-relaxed">"{current.originalValue}"</p>
                  {current.originalSentence && (
                    <p className="text-xs text-slate-500 italic">Na frase: "{current.originalSentence}"</p>
                  )}
                </div>

                <div>
                  <label className="text-sm text-slate-300 mb-2 block">Como você escreveria corretamente?</label>
                  <textarea
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    placeholder="Escreva a forma correta em inglês..."
                    autoFocus
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-slate-100 placeholder-slate-600 text-sm focus:outline-none focus:border-blue-500 min-h-[96px] resize-none"
                  />
                </div>

                {submitError && <p className="text-xs text-amber-400">{submitError}</p>}

                <button
                  onClick={handleVerify}
                  disabled={!answer.trim() || submitting}
                  className="w-full py-3 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {submitting ? (
                    <span className="flex items-center justify-center gap-2">
                      <Loader2 className="w-4 h-4 shrink-0 animate-spin" strokeWidth={2} />
                      Verificando...
                    </span>
                  ) : 'Verificar'}
                </button>
              </>
            ) : (
              <ResultCard result={result} onContinue={handleContinue} isLast={index + 1 >= total} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Result card ───────────────────────────────────────────────────────────────

function ResultCard({ result, onContinue, isLast }: { result: ErrorReviewResult; onContinue: () => void; isLast: boolean }) {
  const passed = result.passed;
  return (
    <div className="space-y-4">
      <div className={`rounded-2xl p-5 space-y-3 ${passed ? 'bg-green-900/20 border border-green-800/40' : 'bg-amber-900/20 border border-amber-800/40'}`}>
        <div className="flex items-center gap-2">
          {passed
            ? <CheckCircle2 className="w-5 h-5 shrink-0 text-green-400" strokeWidth={2} aria-hidden="true" />
            : <AlertTriangle className="w-5 h-5 shrink-0 text-amber-400" strokeWidth={2} aria-hidden="true" />}
          <p className={`text-base font-semibold ${passed ? 'text-green-300' : 'text-amber-300'}`}>
            {passed ? (result.mastered ? 'Dominado!' : 'Certo') : 'Quase'}
          </p>
        </div>

        {!passed && (
          <div className="space-y-1">
            <p className="text-xs text-slate-500">Sua resposta</p>
            <p className="text-sm text-red-300 italic">"{result.originalValue}"</p>
          </div>
        )}

        <div className="space-y-1">
          <p className="text-xs text-slate-500">Forma correta</p>
          <p className="text-sm text-green-300 italic">"{result.correctedValue}"</p>
        </div>

        {result.explanation && (
          <p className="text-sm text-slate-300 leading-relaxed">{result.explanation}</p>
        )}

        {result.mastered && (
          <p className="text-xs text-green-400 flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
            Você dominou este erro. Ele não voltará mais para revisão.
          </p>
        )}
      </div>

      <button
        onClick={onContinue}
        className="w-full py-3 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors"
      >
        {isLast ? 'Concluir' : 'Continuar'}
      </button>
    </div>
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
