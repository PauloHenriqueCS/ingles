import { useEffect } from 'react';
import { X, XCircle, CheckCircle2 } from 'lucide-react';
import { resolveLegacyGrammarTopic } from '../domain/curriculum/legacy-grammar-aliases';
import { findMistakeForTopic } from '../domain/writing/grammar-focus-topics';
import type { RecurringMistake } from '../types';

/**
 * Bottom-sheet explanation for a Revisão → Gramática topic chip.
 *
 * Content is sourced ENTIRELY offline: the pedagogical explanation comes from
 * the single curriculum catalog (resolveLegacyGrammarTopic), and the "recomendado
 * porque você escreveu X em vez de Y" context reuses the learner's already-
 * persisted recurring mistakes. There is NO network request and NO AI call —
 * opening this sheet never consumes quota. When the label has no catalog topic,
 * the learner's own error context plus a general message are shown (never an
 * empty area and never a technical string like "topic not found").
 */
interface Props {
  topicLabel: string;
  mistakes: RecurringMistake[];
  onClose: () => void;
}

export default function GrammarTopicSheet({ topicLabel, mistakes, onClose }: Props) {
  const topic = resolveLegacyGrammarTopic(topicLabel);
  const context = findMistakeForTopic(topicLabel, mistakes);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const displayName = topic?.title.ptBR ?? topicLabel;
  const structures = topic?.structures;

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Explicação de gramática: ${displayName}`}
        className="relative bg-slate-900 rounded-t-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 rounded-full bg-slate-600" />
        </div>

        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700/60 shrink-0">
          <div className="min-w-0">
            <p className="text-[10px] text-slate-500 uppercase tracking-wider font-medium">Gramática</p>
            <p className="text-base font-bold text-slate-100 truncate">{displayName}</p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors shrink-0"
            aria-label="Fechar"
          >
            <X className="w-4 h-4 shrink-0" strokeWidth={2} />
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-5">
          {/* Why this topic was recommended — reuses persisted mistake data */}
          {context && (
            <div className="rounded-xl bg-blue-900/30 border border-blue-700/40 px-4 py-3 space-y-1.5">
              <p className="text-[10px] text-blue-400 uppercase tracking-wider font-semibold">
                Por que este tópico
              </p>
              <p className="text-sm text-blue-100 leading-relaxed">
                Recomendado porque você escreveu{' '}
                <span className="text-red-300 italic">"{context.original}"</span>{' '}
                em vez de{' '}
                <span className="text-green-300 italic">"{context.correct}"</span>.
              </p>
              {context.explanation && (
                <p className="text-xs text-blue-200/80 leading-relaxed">{context.explanation}</p>
              )}
            </div>
          )}

          {topic ? (
            <>
              {topic.communicativeUses.length > 0 && (
                <Section title="Quando usar">
                  <ul className="space-y-1.5">
                    {topic.communicativeUses.map((use, i) => (
                      <li key={i} className="flex gap-2 text-sm text-slate-300 leading-relaxed">
                        <span className="text-slate-500 shrink-0">•</span>
                        <span>{use}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {structures && (structures.affirmative || structures.negative || structures.interrogative || structures.other) && (
                <Section title="Estrutura">
                  <div className="space-y-2">
                    <StructureRow label="+" values={structures.affirmative} />
                    <StructureRow label="−" values={structures.negative} />
                    <StructureRow label="?" values={structures.interrogative} />
                    <StructureRow label="•" values={structures.other} />
                  </div>
                </Section>
              )}

              {topic.examples.length > 0 && (
                <Section title="Exemplos">
                  <div className="space-y-3">
                    {topic.examples.slice(0, 4).map((ex, i) => (
                      <div key={i} className="space-y-0.5">
                        <p className="text-sm text-green-400 leading-relaxed">"{ex.en}"</p>
                        <p className="text-xs text-slate-500 leading-relaxed">"{ex.ptBR}"</p>
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {topic.commonErrors.length > 0 && (
                <Section title="Erro comum">
                  <div className="space-y-3">
                    {topic.commonErrors.slice(0, 2).map((err, i) => (
                      <div key={i} className="rounded-lg bg-slate-800/60 px-3 py-3 space-y-1.5">
                        <p className="text-xs text-red-400 leading-relaxed flex items-start gap-1.5">
                          <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" strokeWidth={2} aria-hidden="true" />
                          {err.incorrect}
                        </p>
                        <p className="text-xs text-green-400 leading-relaxed flex items-start gap-1.5">
                          <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" strokeWidth={2} aria-hidden="true" />
                          {err.correct}
                        </p>
                        <p className="text-xs text-slate-500 leading-relaxed">{err.explanationPtBR}</p>
                      </div>
                    ))}
                  </div>
                </Section>
              )}
            </>
          ) : (
            // No catalog topic for this label — never show an empty area or a
            // technical message; the mistake context above already gives the
            // learner something concrete, plus a general note here.
            <p className="text-sm text-slate-400 leading-relaxed">
              Este tópico foi identificado a partir dos seus erros recentes. Use o exemplo acima
              como referência e continue praticando — a explicação detalhada aparece nos tópicos
              com material cadastrado.
            </p>
          )}

          <div className="h-4" />
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">{title}</p>
      {children}
    </div>
  );
}

function StructureRow({ label, values }: { label: string; values?: readonly string[] }) {
  if (!values || values.length === 0) return null;
  const color = label === '+' ? 'text-green-400' : label === '−' ? 'text-red-400' : label === '?' ? 'text-blue-400' : 'text-slate-400';
  return (
    <div className="flex gap-3 items-start">
      <span className={`text-xs font-bold shrink-0 w-3 mt-0.5 ${color}`}>{label}</span>
      <span className="text-xs text-slate-300 font-mono leading-relaxed">{values.join('  ·  ')}</span>
    </div>
  );
}
