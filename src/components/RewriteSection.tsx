import { useState } from 'react';
import { Loader2, Target } from 'lucide-react';
import { AIFeedback, RewriteComparisonResult } from '../types';
import { getAuthHeader } from '../lib/apiAuth';
import { apiUrl } from '../lib/apiUrl';
import { mapRewriteEvaluationToComparisonResult } from '../lib/rewriteComparisonAdapter';
import type { PublicWritingRewriteDTO } from '../domain/writing-rewrite/rewrite-public-dto';
import { validateRewriteText } from '../domain/writing-rewrite/rewrite-text-validation';
import type { WritingUiStrings } from '../i18n/writingUiStrings';
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
  t: WritingUiStrings;
  /** The final corrected version + its audio belong to the Concluído screen; the
   *  Improve step hides them (generation still runs and persists in the
   *  background). Defaults to true for any other caller. */
  showFinalVersion?: boolean;
  onSaveV2?: (v2Text: string, v2Comparison: RewriteComparisonResult) => void;
  onV2FinalText?: (finalText: string, alreadyPersisted: boolean) => void | Promise<void>;
  /** Fired once a V2 comparison has successfully completed (lets the flow reveal
   *  a "Concluir" action). */
  onAnalyzed?: () => void;
}

/**
 * The "Melhorar meu texto" engine — the optional V2. Presentation was reworked
 * for the focused Improve step (points-to-review guide → editor → analyze →
 * result), and the headline number is now honestly labeled a SCORE
 * ("Nota da versão 2"), not "Melhora" — it is an absolute composite quality
 * score of V2, never a delta vs V1. ALL of the careful network/idempotency
 * behavior is unchanged: one evaluation per review via
 * /api/writing-rewrite-evaluate (reserve_writing_rewrite), a separate,
 * independent final-text generation via /api/compare-rewrite, defensive JSON
 * parsing, and the one-analysis lock.
 */
export default function RewriteSection({
  aiReview,
  reviewId,
  initialV2Text,
  initialV2Comparison,
  initialV2FinalText,
  t,
  showFinalVersion = true,
  onSaveV2,
  onV2FinalText,
  onAnalyzed,
}: Props) {
  const [rewriteText, setRewriteText] = useState(initialV2Text ?? '');
  const [compareState, setCompareState] = useState<CompareState>(initialV2Comparison ? 'done' : 'idle');
  const [result, setResult] = useState<RewriteComparisonResult | null>(initialV2Comparison ?? null);
  const [emptyWarning, setEmptyWarning] = useState(false);
  const [compareErrorMessage, setCompareErrorMessage] = useState<string | null>(null);
  const [finalCorrectedText, setFinalCorrectedText] = useState<string | null>(initialV2FinalText ?? null);
  const [finalCorrectState, setFinalCorrectState] = useState<FinalCorrectState>(initialV2FinalText ? 'done' : 'idle');
  const [finalCorrectErrorMessage, setFinalCorrectErrorMessage] = useState<string | null>(null);
  const isComparing = compareState === 'loading';

  async function generateFinalText(v2Text: string) {
    if (!v2Text || !aiReview.correctedText) {
      setFinalCorrectErrorMessage(null);
      setFinalCorrectState('error');
      return;
    }
    setFinalCorrectState('loading');
    setFinalCorrectErrorMessage(null);
    try {
      const authHeader = await getAuthHeader();
      const res = await fetch(apiUrl('/api/compare-rewrite'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({
          generateFinalTextOnly: true,
          reviewId,
          correctedText: aiReview.correctedText,
          rewriteText: v2Text,
        }),
      });
      // Parsed defensively — a non-JSON body (proxy/edge error page, etc.) must
      // still fall through to the generic, safe message below.
      let data: any = null;
      try { data = await res.json(); } catch { /* non-JSON body */ }
      if (!res.ok) {
        setFinalCorrectErrorMessage(
          typeof data?.message === 'string' && data.message.trim()
            ? data.message
            : 'Não foi possível gerar a versão final corrigida agora. Tente novamente em instantes.',
        );
        setFinalCorrectState('error');
        return;
      }
      const final = String(data?.finalCorrectedText ?? '').trim();
      if (!final) throw new Error('Resposta vazia');
      // The generation is only "done" once the result is safely persisted.
      try {
        await onV2FinalText?.(final, data?.persisted === true);
      } catch (persistErr) {
        console.error('[generate-final-text][persist]', persistErr);
        setFinalCorrectErrorMessage('A versão final foi gerada, mas não foi possível salvá-la. Tente novamente.');
        setFinalCorrectState('error');
        return;
      }
      setFinalCorrectedText(final);
      setFinalCorrectState('done');
    } catch (err) {
      console.error('[generate-final-text]', err);
      setFinalCorrectErrorMessage('Não foi possível gerar a versão final corrigida agora. Verifique sua conexão e tente novamente.');
      setFinalCorrectState('error');
    }
  }

  async function compare() {
    // One analysis per review: once a comparison exists, never fire a second
    // evaluation. The backend is the authority (reserve_writing_rewrite), but
    // the UI reflects it and does not even attempt the call.
    if (compareState === 'done' || compareState === 'loading') return;
    const trimmedRewrite = rewriteText.trim();

    // Content-quality gate — UX only, mirrored authoritatively on the backend.
    const contentCheck = validateRewriteText(trimmedRewrite);
    if (!contentCheck.valid) {
      if (contentCheck.reasonCode === 'EMPTY') {
        setEmptyWarning(true);
        setCompareErrorMessage(null);
      } else {
        setEmptyWarning(false);
        setCompareErrorMessage(contentCheck.message ?? null);
        setCompareState('error');
      }
      return;
    }
    if (!reviewId) {
      console.error('[writing-rewrite-evaluate] missing reviewId — cannot evaluate');
      setCompareErrorMessage(null);
      setCompareState('error');
      return;
    }
    setEmptyWarning(false);
    setCompareErrorMessage(null);
    setCompareState('loading');
    setResult(null);
    try {
      const authHeader = await getAuthHeader();
      const res = await fetch(apiUrl('/api/writing-rewrite-evaluate'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ reviewId, rewriteText: trimmedRewrite }),
      });
      let data: any = null;
      try { data = await res.json(); } catch { /* non-JSON body */ }
      if (!res.ok) {
        setCompareErrorMessage(
          typeof data?.message === 'string' && data.message.trim()
            ? data.message
            : 'Não foi possível analisar sua melhoria agora. Tente novamente em instantes.',
        );
        setCompareState('error');
        return;
      }
      const dto = data.result as PublicWritingRewriteDTO;
      const comparison = mapRewriteEvaluationToComparisonResult(dto);
      setResult(comparison);
      setCompareState('done');
      onSaveV2?.(trimmedRewrite, comparison);
      onAnalyzed?.();

      // Only reached once the evaluation above has actually succeeded — never
      // after a failed or invalid-content-rejected evaluation.
      generateFinalText(trimmedRewrite);
    } catch (err) {
      console.error('[writing-rewrite-evaluate]', err);
      setCompareErrorMessage('Não foi possível analisar sua melhoria agora. Verifique sua conexão e tente novamente.');
      setCompareState('error');
    }
  }

  const hasCompared = compareState === 'done' || !!initialV2Comparison;
  const showGenerateFinalButton =
    showFinalVersion && !finalCorrectedText && finalCorrectState === 'idle' && !!rewriteText.trim() && hasCompared;

  return (
    <div className="space-y-4">
      {/* Points to review — the V1 mistakes as a guide */}
      <div className="bg-slate-800 rounded-xl p-4 space-y-3">
        <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">{t.pointsToReview}</p>
        {aiReview.mainMistakes.length === 0 ? (
          <p className="text-xs text-slate-500">{t.noMainMistakes}</p>
        ) : (
          aiReview.mainMistakes.slice(0, 5).map((m, i) => (
            <div key={i} className="border-b border-slate-700 last:border-0 pb-3 last:pb-0 space-y-1">
              <div className="flex gap-2 text-xs">
                <span className="text-slate-500 shrink-0">{t.youWrote}</span>
                <span className="text-red-400 italic">"{m.original}"</span>
              </div>
              <div className="flex gap-2 text-xs">
                <span className="text-slate-500 shrink-0">{t.corrected}</span>
                <span className="text-green-400 italic">"{m.correct}"</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">{m.explanation}</p>
            </div>
          ))
        )}
      </div>

      {/* Rewrite textarea — locked once the single analysis was consumed */}
      <div className="space-y-2">
        <label className="text-xs text-slate-400 block">{t.newVersionLabel}</label>
        <textarea
          value={rewriteText}
          onChange={(e) => { setRewriteText(e.target.value); setEmptyWarning(false); }}
          readOnly={hasCompared}
          placeholder={t.newVersionPlaceholder}
          className={`w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-slate-100 placeholder-slate-600 text-sm focus:outline-none focus:border-blue-500 min-h-[180px] resize-none ${hasCompared ? 'opacity-70 cursor-not-allowed' : ''}`}
        />
        {emptyWarning && <p className="text-xs text-amber-400">{t.improveEmptyWarning}</p>}
        {hasCompared && <p className="text-xs text-slate-500">{t.alreadyAnalyzed}</p>}
      </div>

      {/* Analyze button — hidden once the one allowed analysis was consumed */}
      {!hasCompared && (
        <button
          onClick={compare}
          disabled={isComparing || finalCorrectState === 'loading'}
          className="w-full py-2.5 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {isComparing ? (
            <span className="flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 shrink-0 animate-spin" strokeWidth={2} />
              {t.analyzingImprovement}
            </span>
          ) : t.analyzeImprovement}
        </button>
      )}

      {/* Compare error */}
      {compareState === 'error' && (
        <div className="bg-red-900/30 border border-red-800 rounded-xl p-4 text-center space-y-2">
          <p className="text-sm text-red-300">{compareErrorMessage ?? 'Não foi possível analisar sua melhoria agora.'}</p>
          <button onClick={compare} className="text-xs text-slate-400 hover:text-slate-200 transition-colors">
            Tentar novamente
          </button>
        </div>
      )}

      {/* Comparison result */}
      {compareState === 'done' && result && <ComparisonResult result={result} t={t} />}

      {/* Final correction loading */}
      {showFinalVersion && finalCorrectState === 'loading' && (
        <div className="bg-slate-800/60 border border-slate-700 rounded-xl px-4 py-3 flex items-center gap-3">
          <Loader2 className="w-4 h-4 shrink-0 text-blue-400 animate-spin" strokeWidth={2} />
          <p className="text-xs text-slate-400">{t.generatingFinal}</p>
        </div>
      )}

      {/* Generate final text button (old records without final text) */}
      {showGenerateFinalButton && (
        <button
          onClick={() => generateFinalText(rewriteText.trim())}
          className="w-full py-2.5 rounded-xl text-sm font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors"
        >
          {t.finalVersionTitle}
        </button>
      )}

      {/* Final corrected text + audio */}
      {showFinalVersion && finalCorrectedText && finalCorrectState === 'done' && (
        <CollapsibleBlock title={t.finalVersionTitle} defaultOpen={true}>
          <div className="space-y-4 pt-1">
            <p className="text-sm text-slate-200 leading-relaxed whitespace-pre-wrap">{finalCorrectedText}</p>
            <div className="border-t border-slate-700 pt-3">
              <p className="text-xs text-slate-500 mb-2">{t.listenText}</p>
              <V2AudioPlayer text={finalCorrectedText} />
            </div>
          </div>
        </CollapsibleBlock>
      )}

      {/* Final correction error */}
      {showFinalVersion && finalCorrectState === 'error' && (
        <div className="bg-red-900/30 border border-red-800 rounded-xl p-4 text-center space-y-2">
          <p className="text-sm text-red-300">{finalCorrectErrorMessage ?? 'Não foi possível gerar a versão final corrigida.'}</p>
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

function ComparisonResult({ result, t }: { result: RewriteComparisonResult; t: WritingUiStrings }) {
  const scoreColor =
    result.improvementScore >= 75 ? 'text-green-400' :
    result.improvementScore >= 50 ? 'text-amber-400' : 'text-red-400';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between py-2">
        <div className="h-px flex-1 bg-slate-700" />
        <span className="text-xs text-slate-500 font-medium uppercase tracking-wider px-3">{t.v2ResultTitle}</span>
        <div className="h-px flex-1 bg-slate-700" />
      </div>

      {/* Score + counters */}
      <div className="bg-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">{t.v2ScoreLabel}</p>
            <span className={`text-5xl font-bold tabular-nums ${scoreColor}`}>{result.improvementScore}</span>
            <span className="text-slate-500 text-lg">/100</span>
          </div>
          <div className="flex gap-3">
            <div className="text-center">
              <p className="text-2xl font-bold text-green-400 tabular-nums">{result.fixedMistakesCount}</p>
              <p className="text-xs text-slate-500">{t.v2Fixed}</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-amber-400 tabular-nums">{result.remainingMistakesCount}</p>
              <p className="text-xs text-slate-500">{t.v2Remaining}</p>
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
          <p className="text-xs text-green-400 font-medium uppercase tracking-wider">{t.v2WhatYouFixed}</p>
          {result.fixedMistakes.map((f, i) => (
            <div key={i} className="border-b border-green-800/20 last:border-0 pb-3 last:pb-0 space-y-1">
              <p className="text-xs text-slate-400 font-medium">{f.mistake}</p>
              <div className="flex gap-2 text-xs">
                <span className="text-slate-500 shrink-0">{t.v2Original}</span>
                <span className="text-slate-400 italic">"{f.original}"</span>
              </div>
              <div className="flex gap-2 text-xs">
                <span className="text-slate-500 shrink-0">{t.v2Version}</span>
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
          <p className="text-xs text-amber-400 font-medium uppercase tracking-wider">{t.v2StillToFix}</p>
          {result.remainingMistakes.map((r, i) => (
            <div key={i} className="border-b border-amber-800/20 last:border-0 pb-3 last:pb-0 space-y-1">
              <p className="text-xs text-slate-400 font-medium">{r.mistake}</p>
              <div className="flex gap-2 text-xs">
                <span className="text-slate-500 shrink-0">{t.v2Version}</span>
                <span className="text-amber-400 italic">"{r.rewrite}"</span>
              </div>
              <div className="flex gap-2 text-xs">
                <span className="text-slate-500 shrink-0">{t.v2CorrectLabel}</span>
                <span className="text-green-400 italic">"{r.correct}"</span>
              </div>
              {r.feedback && <p className="text-xs text-slate-400 leading-relaxed">{r.feedback}</p>}
            </div>
          ))}
        </div>
      )}

      {/* New issues */}
      <div className="bg-slate-800 rounded-xl p-5 space-y-3">
        <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">{t.v2NewIssues}</p>
        {result.newIssues.length === 0 ? (
          <p className="text-xs text-slate-500">{t.v2NoNewIssues}</p>
        ) : (
          result.newIssues.map((n, i) => (
            <div key={i} className="border-b border-slate-700 last:border-0 pb-3 last:pb-0 space-y-1">
              <p className="text-xs text-slate-400 font-medium">{n.issue}</p>
              {n.rewrite && (
                <div className="flex gap-2 text-xs">
                  <span className="text-slate-500 shrink-0">{t.v2Version}</span>
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
            <p className="text-xs text-purple-400 font-medium uppercase tracking-wider">{t.v2NextAction}</p>
          </div>
          <p className="text-sm text-slate-200 leading-relaxed">{result.nextAction}</p>
        </div>
      )}
    </div>
  );
}
