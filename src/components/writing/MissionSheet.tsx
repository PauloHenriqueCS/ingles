import { useEffect, useRef } from 'react';
import { X, Check } from 'lucide-react';
import type { EnglishDailyTheme } from '../../types';
import type { WritingUiStrings } from '../../i18n/writingUiStrings';
import { visibleVocabulary } from '../../domain/writing/mission-vocabulary';

interface Props {
  theme: EnglishDailyTheme;
  t: WritingUiStrings;
  onClose: () => void;
}

/**
 * Bottom sheet that lets the learner consult the mission (objective,
 * instructions, grammar, vocabulary, example, success criteria, extra
 * challenge) WITHOUT leaving the Escrever step — the textarea, cursor and
 * content are untouched, and no mission generation is triggered. Read-only.
 *
 * Accessibility: role=dialog + aria-modal, ESC and overlay close, focus moves
 * into the sheet on open and returns to the trigger on close, and Tab is trapped
 * within the sheet.
 */
export default function MissionSheet({ theme, t, onClose }: Props) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    closeBtnRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'Tab') {
        const root = sheetRef.current;
        if (!root) return;
        const focusables = root.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
      previouslyFocused.current?.focus?.();
    };
  }, [onClose]);

  const vocab = visibleVocabulary(theme.suggestedVocabulary);
  const missionText =
    theme.missionSetup && theme.missionTask
      ? `${theme.missionSetup}\n\n${theme.missionTask}`
      : theme.mission || theme.themePtBr || '';

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" aria-hidden="true" />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={t.sheetTitle}
        className="relative w-full max-w-lg bg-slate-900 border-t border-slate-700 rounded-t-2xl max-h-[85vh] flex flex-col shadow-2xl"
      >
        {/* Grab handle + header */}
        <div className="shrink-0 pt-2">
          <div className="mx-auto w-10 h-1 rounded-full bg-slate-700 mb-2" aria-hidden="true" />
          <div className="flex items-center justify-between px-4 pb-2 border-b border-slate-800">
            <p className="text-sm font-semibold text-slate-100">{t.sheetTitle}</p>
            <button
              ref={closeBtnRef}
              type="button"
              onClick={onClose}
              aria-label={t.sheetClose}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
            >
              <X className="w-5 h-5" strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Scrollable content */}
        <div className="overflow-y-auto px-4 py-4 space-y-4">
          <p className="text-base font-bold text-slate-100">{theme.title}</p>
          {missionText && (
            <p className="text-sm text-slate-200 leading-relaxed whitespace-pre-wrap">{missionText}</p>
          )}

          {theme.objective && (
            <SheetSection title={t.sheetObjective}>
              <p className="text-sm text-slate-300 leading-relaxed">{theme.objective}</p>
            </SheetSection>
          )}

          {theme.instructions.length > 0 && (
            <SheetSection title={t.sheetHowTo}>
              <ol className="space-y-1 list-decimal list-inside">
                {theme.instructions.map((item, i) => (
                  <li key={i} className="text-sm text-slate-300 leading-relaxed">{item}</li>
                ))}
              </ol>
            </SheetSection>
          )}

          {theme.requiredGrammar.length > 0 && (
            <SheetSection title={t.sheetGrammar}>
              <div className="flex flex-wrap gap-1.5">
                {theme.requiredGrammar.map((g, i) => (
                  <span key={i} className="px-2 py-0.5 bg-purple-900/40 border border-purple-800/40 rounded text-xs text-purple-300">
                    {g}
                  </span>
                ))}
              </div>
            </SheetSection>
          )}

          {vocab.length > 0 && (
            <SheetSection title={t.sheetVocabulary}>
              <div className="space-y-2">
                {vocab.map((v, i) => (
                  <div key={i}>
                    <div className="flex items-baseline gap-2">
                      <span className="text-blue-400 font-semibold text-sm">{v.word}</span>
                      <span className="text-slate-500 text-xs">{v.meaningPtBr}</span>
                    </div>
                    {v.example && <p className="text-slate-500 text-xs italic">"{v.example}"</p>}
                  </div>
                ))}
              </div>
            </SheetSection>
          )}

          {theme.exampleSentence && (
            <SheetSection title={t.sheetExample}>
              <p className="text-sm text-green-400 italic">"{theme.exampleSentence}"</p>
            </SheetSection>
          )}

          {theme.successCriteria.length > 0 && (
            <SheetSection title={t.sheetSuccess}>
              <ul className="space-y-1">
                {theme.successCriteria.map((c, i) => (
                  <li key={i} className="flex gap-2 text-sm text-slate-300">
                    <Check className="w-3.5 h-3.5 shrink-0 text-green-500 mt-0.5" strokeWidth={2} aria-hidden="true" />
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </SheetSection>
          )}

          {theme.extraChallenge && (
            <SheetSection title={t.sheetChallenge}>
              <p className="text-sm text-amber-400 leading-relaxed">{theme.extraChallenge}</p>
            </SheetSection>
          )}
        </div>
      </div>
    </div>
  );
}

function SheetSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-slate-500 font-medium uppercase tracking-wider">{title}</p>
      {children}
    </div>
  );
}
