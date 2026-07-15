import { useState } from 'react';
import { Loader2, Target } from 'lucide-react';
import { AIFeedback, RewriteComparisonResult } from '../types';
import { getAuthHeader } from '../lib/apiAuth';
import V2AudioPlayer from './V2AudioPlayer';
import CollapsibleBlock from './CollapsibleBlock';

type CompareState = 'idle' | 'loading' | 'done' | 'error';
type FinalCorrectState = 'idle' | 'loading' | 'done' | 'error';

interface Props {
  originalText: string;
  aiReview: AIFeedback;
  reviewId?: string;
  initialV2Text?: string;
  initialV2Comparison?: RewriteComparisonResult;
  initialV2FinalText?: string;
  studentLevel?: string;
  onSaveV2?: (v2Text: string, v2Comparison: RewriteComparisonResult) => void;
  onV2FinalText?: (finalText: string) => void;
}

export default function RewriteSection({
  originalText,
  aiReview,
  initialV2Text,
  initialV2Comparison,
  initialV2FinalText,
  onSaveV2,
  onV2FinalText,
}: Props) {
  const [rewriteText, setRewriteText] = useState(initialV2Text ?? '');
  const [compareState, setCompareState] = useState<CompareState>(initialV2Comparison ? 'done' : 'idle');
  const [result, setResult] = useState<RewriteComparisonResult | null>(initialV2Comparison ?? null);
  const [emptyWarning, setEmptyWarning] = useState(false);
  const [finalCorrectedText, setFinalCorrectedText] = useState<string | null>(initialV2FinalText ?? null);
  const [finalCorrectState, setFinalCorrectState] = useState<FinalCorrectState>(initialV2FinalText ? 'done' : 'idle');
  const isComparing = compareState === 'loading';

  async function generateFinalText(v2Text: string) {
    if (!v2Text || !aiReview.correctedText) { setFinalCorrectState('error'); return; }
    setFinalCorrectState('loading');
    try {
      const authHeader = await getAuthHeader();
      const res = await fetch('/api/compare-rewrite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({
          generateFinalTextOnly: true,
          correctedText: aiReview.correctedText,
          rewriteText: v2Text,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? data.error ?? `HTTP ${res.status}`);
      const final = String(data.finalCorrectedText ?? '').trim();
      if (!final) throw new Error('Resposta vazia');
      setFinalCorrectedText(final);
      setFinalCorrectState('done');
      onV2FinalText?.(final);
    } catch (err) {
      console.error('[generate-final-text]', err);
      setFinalCorrectState('error');
    }
  }

  async function compare() {
    if (!rewriteText.trim()) {
      setEmptyWarning(true);
      return;
    }
    setEmptyWarning(false);
    setCompareState('loading');
    setResult(null);
    try {
      const authHeader = await getAuthHeader();
      const res = await fetch('/api/compare-rewrite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({
          originalText,
          correctedText: aiReview.correctedText,
          rewriteText: rewriteText.trim(),
          mainMistakes: aiReview.mainMistakes,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? data.error ?? `HTTP ${res.status}`);
      const comparison = data.result as RewriteComparisonResult;
      setResult(comparison);
      setCompareState('done');
      onSaveV2?.(rewriteText.trim(), comparison);
      // Server also returns finalCorrectedText in the same response
      const serverFinal = typeof data.finalCorrectedText === 'string' ? data.finalCorrectedText.trim() : '';
      if (serverFinal) {
        setFinalCorrectedText(serverFinal);
        setFinalCorrectState('done');
        onV2FinalText?.(serverFinal);
      }
    } catch (err) {
      console.error('[compare-rewrite]', err);
      setCompareState('error');
    }
  }

  const hasCompared = compareState === 'done' || !!(initialV2Comparison);
  const showGenerateFinalButton =
    !finalCorrectedText && finalCorrectState === 'idle' && !!(rewriteText.trim()) && hasCompared;

  return (
    <div className="space-y-4">
      {/* Motivation */}
      <div className="bg-blue-900/20 border border-blue-800/30 rounded-xl p-4 space-y-1">
        <p className="text-sm text-slate-200 leading-relaxed">
          Boa, agora vamos ver o que você conseguiu melhorar.
        </p>
        <p className="text-xs text-slate-400 leading-relaxed">
          Tente reescrever seu texto corrigindo os erros apontados, sem copiar o texto corrigido inteiro. A versão 2 serve para treinar sua autonomia — não precisa ficar perfeita.
        </p>
      </div>

      {/* Error guide */}
      <div className="bg-slate-800 rounded-xl p-4 space-y-3">
        <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Use os erros como guia</p>
        {aiReview.mainMistakes.length === 0 ? (
          <p className="text-xs text-slate-500">Não encontramos erros principais suficientes, mas você ainda pode tentar melhorar sua versão.</p>
        ) : (
          aiReview.mainMistakes.slice(0, 5).map((m, i) => (
            <div key={i} className="border-b border-slate-700 last:border-0 pb-3 last:pb-0 space-y-1">
              <div className="flex gap-2 text-xs">
                <span className="text-slate-500 shrink-0">Você escreveu:</span>
                <span className="text-red-400 italic">"{m.original}"</span>
              </div>
              <div className="flex gap-2 text-xs">
                <span className="text-slate-500 shrink-0">Correto:</span>
                <span className="text-green-400 italic">"{m.correct}"</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">{m.explanation}</p>
            </div>
          ))
        )}
      </div>

      {/* Rewrite textarea */}
      <div className="space-y-2">
        <label className="text-xs text-slate-400 block">Sua versão 2</label>
        <textarea
          value={rewriteText}
          onChange={(e) => { setRewriteText(e.target.value); setEmptyWarning(false); }}
          placeholder="Reescreva seu texto aqui tentando corrigir os erros apontados pela IA."
          className="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-slate-100 placeholder-slate-600 text-sm focus:outline-none focus:border-blue-500 min-h-[180px] resize-none"
        />
        {emptyWarning && (
          <p className="text-xs text-amber-400">Escreva sua versão 2 antes de comparar.</p>
        )}
      </div>

      {/* Compare button */}
      <button
        onClick={compare}
        disabled={isComparing || finalCorrectState === 'loading'}
        className="w-full py-2.5 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {isComparing ? (
          <span className="flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 shrink-0 animate-spin" strokeWidth={2} />
            Comparando sua versão 2...
          </span>
        ) : 'Comparar versão 2'}
      </button>

      {/* Compare error */}
      {compareState === 'error' && (
        <div className="bg-red-900/30 border border-red-800 rounded-xl p-4 text-center space-y-2">
          <p className="text-sm text-red-300">Não foi possível comparar sua versão 2 agora.</p>
          <button onClick={compare} className="text-xs text-slate-400 hover:text-slate-200 transition-colors">
            Tentar novamente
          </button>
        </div>
      )}

      {/* Comparison result */}
      {compareState === 'done' && result && (
        <ComparisonResult result={result} />
      )}

      {/* Final correction loading */}
      {finalCorrectState === 'loading' && (
        <div className="bg-slate-800/60 border border-slate-700 rounded-xl px-4 py-3 flex items-center gap-3">
          <Loader2 className="w-4 h-4 shrink-0 text-blue-400 animate-spin" strokeWidth={2} />
          <p className="text-xs text-slate-400">Gerando versão final corrigida...</p>
        </div>
      )}

      {/* Generate final text button (old records without final text) */}
      {showGenerateFinalButton && (
        <button
          onClick={() => generateFinalText(rewriteText.trim())}
          className="w-full py-2.5 rounded-xl text-sm font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors"
        >
          Gerar versão final corrigida
        </button>
      )}

      {/* Final corrected text + audio */}
      {finalCorrectedText && finalCorrectState === 'done' && (
        <CollapsibleBlock title="Versão final corrigida" defaultOpen={true}>
          <div className="space-y-4 pt-1">
            <p className="text-sm text-slate-200 leading-relaxed whitespace-pre-wrap">{finalCorrectedText}</p>
            <div className="border-t border-slate-700 pt-3">
              <p className="text-xs text-slate-500 mb-2">Ouça a versão final corrigida</p>
              <V2AudioPlayer text={finalCorrectedText} />
            </div>
          </div>
        </CollapsibleBlock>
      )}

      {/* Final correction error */}
      {finalCorrectState === 'error' && (
        <div className="bg-red-900/30 border border-red-800 rounded-xl p-4 text-center space-y-2">
          <p className="text-sm text-red-300">Não foi possível gerar a versão final corrigida.</p>
          <button
            onClick={() => generateFinalText(rewriteText.trim())}
            className="text-xs text-slate-400 hover:text-slate-200 transition-colors"
          >
            Tentar novamente
          </button>
        </div>
      )}
    </div>
  );
}

// ── Comparison result ─────────────────────────────────────────────────────────

function ComparisonResult({ result }: { result: RewriteComparisonResult }) {
  const scoreColor =
    result.improvementScore >= 75 ? 'text-green-400' :
    result.improvementScore >= 50 ? 'text-amber-400' : 'text-red-400';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between py-2">
        <div className="h-px flex-1 bg-slate-700" />
        <span className="text-xs text-slate-500 font-medium uppercase tracking-wider px-3">Resultado da versão 2</span>
        <div className="h-px flex-1 bg-slate-700" />
      </div>

      {/* Score + counters */}
      <div className="bg-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">Melhora da versão 2</p>
            <span className={`text-5xl font-bold tabular-nums ${scoreColor}`}>{result.improvementScore}</span>
            <span className="text-slate-500 text-lg">/100</span>
          </div>
          <div className="flex gap-3">
            <div className="text-center">
              <p className="text-2xl font-bold text-green-400 tabular-nums">{result.fixedMistakesCount}</p>
              <p className="text-xs text-slate-500">corrigidos</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-amber-400 tabular-nums">{result.remainingMistakesCount}</p>
              <p className="text-xs text-slate-500">restantes</p>
            </div>
          </div>
        </div>

        {result.overallFeedback && (
          <p className="text-sm text-slate-200 leading-relaxed border-t border-slate-700 pt-3">
            {result.overallFeedback}
          </p>
        )}
      </div>

      {/* Fixed mistakes */}
      {result.fixedMistakes.length > 0 && (
        <div className="bg-green-900/20 border border-green-800/30 rounded-xl p-5 space-y-3">
          <p className="text-xs text-green-400 font-medium uppercase tracking-wider">O que você corrigiu ✓</p>
          {result.fixedMistakes.map((f, i) => (
            <div key={i} className="border-b border-green-800/20 last:border-0 pb-3 last:pb-0 space-y-1">
              <p className="text-xs text-slate-400 font-medium">{f.mistake}</p>
              <div className="flex gap-2 text-xs">
                <span className="text-slate-500 shrink-0">Original:</span>
                <span className="text-slate-400 italic">"{f.original}"</span>
              </div>
              <div className="flex gap-2 text-xs">
                <span className="text-slate-500 shrink-0">Versão 2:</span>
                <span className="text-green-400 italic">"{f.rewrite}"</span>
              </div>
              {f.feedback && <p className="text-xs text-slate-400 leading-relaxed">{f.feedback}</p>}
            </div>
          ))}
        </div>
      )}

      {/* Remaining mistakes */}
      {result.remainingMistakes.length > 0 && (
        <div className="bg-amber-900/20 border border-amber-800/30 rounded-xl p-5 space-y-3">
          <p className="text-xs text-amber-400 font-medium uppercase tracking-wider">O que ainda falta corrigir</p>
          {result.remainingMistakes.map((r, i) => (
            <div key={i} className="border-b border-amber-800/20 last:border-0 pb-3 last:pb-0 space-y-1">
              <p className="text-xs text-slate-400 font-medium">{r.mistake}</p>
              <div className="flex gap-2 text-xs">
                <span className="text-slate-500 shrink-0">Versão 2:</span>
                <span className="text-amber-400 italic">"{r.rewrite}"</span>
              </div>
              <div className="flex gap-2 text-xs">
                <span className="text-slate-500 shrink-0">Correto:</span>
                <span className="text-green-400 italic">"{r.correct}"</span>
              </div>
              {r.feedback && <p className="text-xs text-slate-400 leading-relaxed">{r.feedback}</p>}
            </div>
          ))}
        </div>
      )}

      {/* New issues */}
      <div className="bg-slate-800 rounded-xl p-5 space-y-3">
        <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Novos pontos de atenção</p>
        {result.newIssues.length === 0 ? (
          <p className="text-xs text-slate-500">Nenhum novo problema importante encontrado.</p>
        ) : (
          result.newIssues.map((n, i) => (
            <div key={i} className="border-b border-slate-700 last:border-0 pb-3 last:pb-0 space-y-1">
              <p className="text-xs text-slate-400 font-medium">{n.issue}</p>
              {n.rewrite && (
                <div className="flex gap-2 text-xs">
                  <span className="text-slate-500 shrink-0">Versão 2:</span>
                  <span className="text-amber-400 italic">"{n.rewrite}"</span>
                </div>
              )}
              {n.suggestion && <p className="text-xs text-slate-400 leading-relaxed">{n.suggestion}</p>}
            </div>
          ))
        )}
      </div>

      {/* Next action */}
      {result.nextAction && (
        <div className="bg-purple-900/20 border border-purple-800/30 rounded-xl p-4 space-y-1.5">
          <div className="flex items-center gap-2">
            <Target className="w-4 h-4 shrink-0 text-purple-400" strokeWidth={2} aria-hidden="true" />
            <p className="text-xs text-purple-400 font-medium uppercase tracking-wider">Próxima ação</p>
          </div>
          <p className="text-sm text-slate-200 leading-relaxed">{result.nextAction}</p>
        </div>
      )}
    </div>
  );
}
