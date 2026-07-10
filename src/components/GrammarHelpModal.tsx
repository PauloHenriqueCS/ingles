import { useEffect } from 'react';
import { findGrammarContent } from '../lib/grammarContent';

interface Props {
  grammarName: string;
  missionTip?: string;
  onClose: () => void;
}

export default function GrammarHelpModal({ grammarName, missionTip, onClose }: Props) {
  const content = findGrammarContent(grammarName);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" />

      {/* Sheet */}
      <div
        className="relative bg-slate-900 rounded-t-2xl max-h-[88vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 rounded-full bg-slate-600" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700/60 shrink-0">
          <div>
            <p className="text-[10px] text-slate-500 uppercase tracking-wider font-medium">Gramática</p>
            <p className="text-base font-bold text-slate-100">{content?.name ?? grammarName}</p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full bg-slate-800 text-slate-400 hover:text-slate-200 text-lg leading-none"
            aria-label="Fechar"
          >
            ×
          </button>
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto px-5 py-4 space-y-5">
          {!content ? (
            <NoStaticContent grammarName={grammarName} missionTip={missionTip} />
          ) : (
            <>
              {/* Summary */}
              <p className="text-sm text-slate-300 leading-relaxed">{content.summaryPt}</p>

              {/* Mission tip */}
              {missionTip && (
                <div className="rounded-xl bg-blue-900/30 border border-blue-700/40 px-4 py-3 space-y-1">
                  <p className="text-[10px] text-blue-400 uppercase tracking-wider font-semibold">
                    Dica para esta missão
                  </p>
                  <p className="text-sm text-blue-200 leading-relaxed">{missionTip}</p>
                </div>
              )}

              {/* When to use */}
              <Section title="Quando usar">
                <ul className="space-y-1.5">
                  {content.whenToUse.map((item, i) => (
                    <li key={i} className="flex gap-2 text-sm text-slate-300 leading-relaxed">
                      <span className="text-slate-500 shrink-0">•</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </Section>

              {/* Structure */}
              <Section title="Estrutura">
                <div className="space-y-2">
                  <StructureRow label="+" value={content.structure.affirmative} />
                  <StructureRow label="−" value={content.structure.negative} />
                  <StructureRow label="?" value={content.structure.question} />
                </div>
              </Section>

              {/* Examples */}
              <Section title="Exemplos">
                <div className="space-y-3">
                  {content.examples.map((ex, i) => (
                    <div key={i} className="space-y-0.5">
                      <p className="text-sm text-green-400 leading-relaxed">"{ex.english}"</p>
                      <p className="text-xs text-slate-500 leading-relaxed">"{ex.portuguese}"</p>
                    </div>
                  ))}
                </div>
              </Section>

              {/* Common mistakes */}
              {content.commonMistakes.length > 0 && (
                <Section title="Erros comuns">
                  <div className="space-y-3">
                    {content.commonMistakes.map((m, i) => (
                      <div key={i} className="rounded-lg bg-slate-800/60 px-3 py-3 space-y-1.5">
                        <p className="text-xs text-red-400 line-through leading-relaxed">✗ {m.wrong}</p>
                        <p className="text-xs text-green-400 leading-relaxed">✓ {m.correct}</p>
                        <p className="text-xs text-slate-500 leading-relaxed">{m.explanationPt}</p>
                      </div>
                    ))}
                  </div>
                </Section>
              )}
            </>
          )}

          {/* Bottom padding for safe area */}
          <div className="h-4" />
        </div>
      </div>
    </div>
  );
}

function NoStaticContent({ grammarName, missionTip }: { grammarName: string; missionTip?: string }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-400">
        Não há explicação detalhada cadastrada para <span className="text-slate-200 font-medium">"{grammarName}"</span> ainda.
      </p>
      {missionTip && (
        <div className="rounded-xl bg-blue-900/30 border border-blue-700/40 px-4 py-3 space-y-1">
          <p className="text-[10px] text-blue-400 uppercase tracking-wider font-semibold">Dica para esta missão</p>
          <p className="text-sm text-blue-200 leading-relaxed">{missionTip}</p>
        </div>
      )}
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

function StructureRow({ label, value }: { label: string; value: string }) {
  const color =
    label === '+' ? 'text-green-400' : label === '−' ? 'text-red-400' : 'text-blue-400';
  return (
    <div className="flex gap-3 items-start">
      <span className={`text-xs font-bold shrink-0 w-3 mt-0.5 ${color}`}>{label}</span>
      <span className="text-xs text-slate-300 font-mono leading-relaxed">{value}</span>
    </div>
  );
}
