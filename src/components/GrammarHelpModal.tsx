import { useEffect, useState } from 'react';
import { X, XCircle, CheckCircle2, Lightbulb, AlertTriangle } from 'lucide-react';
import { findGrammarContent, GrammarContent } from '../lib/grammarContent';
import { apiUrl } from '../lib/apiUrl';

interface Props {
  grammarName: string;
  missionTip?: string;
  onClose: () => void;
}

type Status = 'static' | 'loading' | 'ready' | 'error';

export default function GrammarHelpModal({ grammarName, missionTip, onClose }: Props) {
  const staticContent = findGrammarContent(grammarName);

  const [content, setContent] = useState<GrammarContent | null>(staticContent);
  const [status, setStatus] = useState<Status>(staticContent ? 'static' : 'loading');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  useEffect(() => {
    if (staticContent) return; // Have local content, skip API

    let cancelled = false;
    setStatus('loading');
    setErrorMsg(null);

    fetch(apiUrl('/api/grammar-explanation'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grammarName }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data?.content) {
          setContent(data.content as GrammarContent);
          setStatus('ready');
        } else {
          setErrorMsg(data?.error ?? 'Erro ao gerar explicação.');
          setStatus('error');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setErrorMsg('Não foi possível conectar ao servidor.');
          setStatus('error');
        }
      });

    return () => { cancelled = true; };
  }, [grammarName, staticContent]);

  const displayName = content?.name ?? grammarName;

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />

      <div
        className="relative bg-slate-900 rounded-t-2xl max-h-[90vh] flex flex-col"
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
            <p className="text-base font-bold text-slate-100">{displayName}</p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
            aria-label="Fechar"
          >
            <X className="w-4 h-4 shrink-0" strokeWidth={2} />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto px-5 py-4 space-y-5">
          {status === 'loading' && <LoadingState />}
          {status === 'error' && <ErrorState msg={errorMsg} grammarName={grammarName} missionTip={missionTip} />}
          {(status === 'static' || status === 'ready') && content && (
            <GrammarBody content={content} missionTip={missionTip} />
          )}
          <div className="h-4" />
        </div>
      </div>
    </div>
  );
}

// ── Loading ───────────────────────────────────────────────────────────────────

function LoadingState() {
  return (
    <div className="flex flex-col items-center gap-4 py-10">
      <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      <p className="text-sm text-slate-400">Gerando explicação...</p>
      <p className="text-xs text-slate-600 text-center">
        Isso acontece apenas na primeira vez. A próxima será instantânea.
      </p>
    </div>
  );
}

// ── Error ─────────────────────────────────────────────────────────────────────

function ErrorState({ msg, grammarName, missionTip }: { msg: string | null; grammarName: string; missionTip?: string }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-red-400">
        {msg ?? 'Não foi possível gerar a explicação.'} Tente fechar e abrir novamente.
      </p>
      {missionTip && (
        <MissionTipCard tip={missionTip} />
      )}
      <p className="text-xs text-slate-500">
        Tópico: <span className="text-slate-300">{grammarName}</span>
      </p>
    </div>
  );
}

// ── Full content ──────────────────────────────────────────────────────────────

function GrammarBody({ content, missionTip }: { content: GrammarContent; missionTip?: string }) {
  return (
    <>
      {/* Summary */}
      <p className="text-sm text-slate-300 leading-relaxed">{content.summaryPt}</p>

      {/* Mission tip — most contextual, show early */}
      {missionTip && <MissionTipCard tip={missionTip} />}

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
                <p className="text-xs text-red-400 leading-relaxed flex items-start gap-1.5">
                  <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" strokeWidth={2} aria-hidden="true" />
                  {m.wrong}
                </p>
                <p className="text-xs text-green-400 leading-relaxed flex items-start gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" strokeWidth={2} aria-hidden="true" />
                  {m.correct}
                </p>
                <p className="text-xs text-slate-500 leading-relaxed">{m.explanationPt}</p>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Tips */}
      {content.tips && content.tips.length > 0 && (
        <Section title="Dicas">
          <ul className="space-y-1.5">
            {content.tips.map((tip, i) => (
              <li key={i} className="flex gap-2 text-sm text-amber-300 leading-relaxed">
                <Lightbulb className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={2} aria-hidden="true" />
                <span>{tip}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Traps */}
      {content.traps && content.traps.length > 0 && (
        <Section title="Armadilhas para brasileiros">
          <ul className="space-y-1.5">
            {content.traps.map((trap, i) => (
              <li key={i} className="flex gap-2 text-sm text-orange-300 leading-relaxed">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={2} aria-hidden="true" />
                <span>{trap}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Final summary */}
      {content.finalSummaryPt && (
        <div className="rounded-xl bg-slate-800/60 border border-slate-700/40 px-4 py-3">
          <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold mb-1">Resumo</p>
          <p className="text-sm text-slate-300 leading-relaxed">{content.finalSummaryPt}</p>
        </div>
      )}
    </>
  );
}

// ── Shared ────────────────────────────────────────────────────────────────────

function MissionTipCard({ tip }: { tip: string }) {
  return (
    <div className="rounded-xl bg-blue-900/30 border border-blue-700/40 px-4 py-3 space-y-1">
      <p className="text-[10px] text-blue-400 uppercase tracking-wider font-semibold">
        Dica para esta missão
      </p>
      <p className="text-sm text-blue-200 leading-relaxed">{tip}</p>
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
  const color = label === '+' ? 'text-green-400' : label === '−' ? 'text-red-400' : 'text-blue-400';
  return (
    <div className="flex gap-3 items-start">
      <span className={`text-xs font-bold shrink-0 w-3 mt-0.5 ${color}`}>{label}</span>
      <span className="text-xs text-slate-300 font-mono leading-relaxed">{value}</span>
    </div>
  );
}
