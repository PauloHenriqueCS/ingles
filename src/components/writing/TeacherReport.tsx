import { useState } from 'react';
import { CheckCircle2, AlertTriangle, Target } from 'lucide-react';
import { AIFeedback, MainMistake, VocabularyItem } from '../../types';

/**
 * The FULL detailed teacher's report. In the redesigned flow this is SECONDARY:
 * the Feedback step leads with a compact summary and reveals this on demand
 * ("Ver relatório completo"). No pedagogical information was removed — every card
 * the old stacked report showed lives here. (Its inner labels are the existing
 * pt-BR copy; only the new flow chrome around it is interface-language aware.)
 */
export default function TeacherReport({
  review,
  grammarObjective,
}: {
  review: AIFeedback;
  grammarObjective: string;
}) {
  return (
    <div className="space-y-4">
      <ScoresCard review={review} />
      {review.summary && <SummaryCard text={review.summary} />}
      <CorrectedTextCard text={review.correctedText} />
      {review.mainMistakes.length > 0 && <MainMistakesCard items={review.mainMistakes} />}
      {review.newVocabulary.length > 0 && <VocabularyCard items={review.newVocabulary} />}
      {review.objectiveFeedback && (
        <ObjectiveFeedbackCard text={review.objectiveFeedback} objective={grammarObjective} />
      )}
      {review.nextPractice && <NextPracticeCard text={review.nextPractice} />}
    </div>
  );
}

export function ScoresCard({ review }: { review: AIFeedback }) {
  const scoreColor =
    review.score >= 75 ? 'text-green-400' : review.score >= 50 ? 'text-amber-400' : 'text-red-400';
  return (
    <div className="bg-slate-800 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">Nota Geral</p>
          <span className={`text-6xl font-bold tabular-nums ${scoreColor}`}>{review.score}</span>
          <span className="text-slate-500 text-lg">/100</span>
        </div>
        <div className="text-right space-y-2">
          <p className="text-xs text-slate-400 uppercase tracking-wider">Writing Level</p>
          <span className="block px-3 py-1.5 rounded-lg bg-blue-900 text-blue-300 text-lg font-bold">
            {review.level}
          </span>
        </div>
      </div>
      <div className="space-y-2.5 pt-2 border-t border-slate-700">
        <ScoreBar label="Gramática" value={review.grammar} />
        <ScoreBar label="Vocabulário" value={review.vocabulary} />
        <ScoreBar label="Naturalidade" value={review.naturalness} />
        <ScoreBar label="Fluência" value={review.fluency} />
      </div>
    </div>
  );
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  const color = value >= 75 ? 'bg-green-500' : value >= 50 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-slate-400 w-24 shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width: `${value}%` }} />
      </div>
      <span className="text-xs text-slate-300 w-7 text-right tabular-nums">{value}</span>
    </div>
  );
}

function SummaryCard({ text }: { text: string }) {
  return (
    <div className="bg-blue-900/20 border border-blue-800/30 rounded-xl p-5 space-y-2">
      <p className="text-xs text-blue-400 font-medium uppercase tracking-wider">Resumo do Professor</p>
      <p className="text-slate-200 text-sm leading-relaxed">{text}</p>
    </div>
  );
}

export function CorrectedTextCard({ text, title = 'Texto Corrigido' }: { text: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <div className="bg-slate-800 rounded-xl p-5 space-y-3">
      <div className="flex justify-between items-center">
        <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">{title}</p>
        <button onClick={copy} className="text-xs text-blue-400 hover:text-blue-300 transition-colors">
          {copied ? '✓ Copiado' : 'Copiar'}
        </button>
      </div>
      <p className="text-slate-200 text-sm leading-relaxed whitespace-pre-wrap">{text}</p>
    </div>
  );
}

function MainMistakesCard({ items }: { items: MainMistake[] }) {
  return (
    <div className="bg-slate-800 rounded-xl p-5 space-y-4">
      <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Principais Erros</p>
      {items.map((item, i) => (
        <div key={i} className="space-y-1.5 border-b border-slate-700 last:border-0 pb-4 last:pb-0">
          <div className="flex gap-2 text-xs">
            <span className="text-slate-500 shrink-0 w-24">Você escreveu:</span>
            <span className="text-red-400 italic">"{item.original}"</span>
          </div>
          <div className="flex gap-2 text-xs">
            <span className="text-slate-500 shrink-0 w-24">Correção:</span>
            <span className="text-green-400 italic">"{item.correct}"</span>
          </div>
          <div className="flex gap-2 text-xs">
            <span className="text-slate-500 shrink-0 w-24">Explicação:</span>
            <span className="text-slate-300 leading-relaxed">{item.explanation}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function VocabularyCard({ items }: { items: VocabularyItem[] }) {
  return (
    <div className="bg-slate-800 rounded-xl p-5 space-y-3">
      <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Vocabulário Novo</p>
      <div className="space-y-3">
        {items.map((item, i) => (
          <div key={i} className="border-b border-slate-700 last:border-0 pb-3 last:pb-0">
            <div className="flex items-baseline gap-2 mb-0.5">
              <span className="text-blue-400 font-semibold text-sm">{item.word}</span>
              <span className="text-slate-500 text-xs">{item.meaningPtBr}</span>
            </div>
            <p className="text-slate-400 text-xs italic">"{item.example}"</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function ObjectiveFeedbackCard({ text, objective }: { text: string; objective: string }) {
  const achieved = /cumpr|atingi|usou|utilizou|sim|yes/i.test(text);
  return (
    <div className={`rounded-xl p-4 space-y-2 ${
      achieved ? 'bg-green-900/20 border border-green-800/30' : 'bg-amber-900/20 border border-amber-800/30'
    }`}>
      <div className="flex items-center gap-2">
        {achieved
          ? <CheckCircle2 className="w-4 h-4 shrink-0 text-green-400" strokeWidth={2} aria-hidden="true" />
          : <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" strokeWidth={2} aria-hidden="true" />}
        <p className={`text-xs font-medium uppercase tracking-wider ${achieved ? 'text-green-400' : 'text-amber-400'}`}>
          Feedback do Objetivo
        </p>
      </div>
      {objective && <p className="text-xs text-slate-500 italic">{objective}</p>}
      <p className="text-sm text-slate-200 leading-relaxed">{text}</p>
    </div>
  );
}

function NextPracticeCard({ text }: { text: string }) {
  return (
    <div className="bg-purple-900/20 border border-purple-800/30 rounded-xl p-5 space-y-2">
      <div className="flex items-center gap-2">
        <Target className="w-4 h-4 shrink-0 text-purple-400" strokeWidth={2} aria-hidden="true" />
        <p className="text-xs text-purple-400 font-medium uppercase tracking-wider">Próxima Prática</p>
      </div>
      <p className="text-slate-300 text-sm leading-relaxed">{text}</p>
    </div>
  );
}
