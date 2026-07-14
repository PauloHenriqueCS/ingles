import { useEffect, useRef } from 'react';
import type { PronunciationWordDetail } from '../lib/pronunciationWordParser';
import { getWordBand, getWordGuidance, WORD_BANDS } from '../lib/pronunciationWordParser';

interface Props {
  word: PronunciationWordDetail | null;
  returnFocusId: string | null;
  onClose: () => void;
}

export default function PronunciationWordDetailPanel({ word, returnFocusId, onClose }: Props) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Focus management: move focus into panel on open, return on close
  useEffect(() => {
    if (word) {
      closeButtonRef.current?.focus();
    } else if (returnFocusId) {
      document.getElementById(returnFocusId)?.focus();
    }
  }, [word, returnFocusId]);

  // Escape key closes the panel
  useEffect(() => {
    if (!word) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [word, onClose]);

  if (!word) return null;

  const band = getWordBand(word);
  const guidance = getWordGuidance(word);
  const scoreLabel =
    word.accuracyScore !== null
      ? `${Math.round(word.accuracyScore)} / 100`
      : 'Não disponível';

  const errorLabels: Record<string, string> = {
    none:             'Pronunciado corretamente',
    mispronunciation: 'Pronúncia divergente',
    omission:         'Não identificada na gravação',
    insertion:        'Palavra adicional',
    unexpected_break: 'Pausa inesperada',
    missing_break:    'Pausa ausente',
    monotone:         'Entonação monótona',
    unknown:          'Tipo não identificado',
  };

  const recognizedDiffers =
    word.recognizedWord !== null &&
    word.referenceWord !== null &&
    word.recognizedWord.toLowerCase() !== word.referenceWord.toLowerCase().replace(/[^a-z']/g, '');

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end"
      onClick={onClose}
      aria-hidden="false"
    >
      <div className="absolute inset-0 bg-black/60" aria-hidden="true" />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="word-detail-title"
        className="relative bg-slate-900 rounded-t-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1 shrink-0" aria-hidden="true">
          <div className="w-10 h-1 rounded-full bg-slate-600" />
        </div>

        {/* Header */}
        <div className="flex items-start justify-between px-5 py-3 border-b border-slate-700/60 shrink-0">
          <div className="space-y-0.5">
            <p className="text-[10px] text-slate-500 uppercase tracking-wider font-medium">
              Detalhe da palavra
            </p>
            <p
              id="word-detail-title"
              className={`text-xl font-bold ${band.colorClass}`}
            >
              {word.displayWord}
            </p>
            {recognizedDiffers && word.recognizedWord && (
              <p className="text-xs text-slate-500">
                O Azure identificou:{' '}
                <span className="text-slate-300 font-medium">{word.recognizedWord}</span>
              </p>
            )}
          </div>
          <button
            ref={closeButtonRef}
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full bg-slate-800 text-slate-400 hover:text-slate-200 text-lg leading-none shrink-0 focus:outline-none focus:ring-2 focus:ring-slate-500"
            aria-label="Fechar detalhe da palavra"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto px-5 py-4 space-y-5">

          {/* Score + classification */}
          <div className="flex items-center gap-3">
            <div
              className={`px-3 py-1.5 rounded-lg border text-sm font-semibold ${band.bgClass} ${band.borderClass} ${band.colorClass}`}
            >
              {scoreLabel}
            </div>
            <div>
              <p className={`text-sm font-medium ${band.colorClass}`}>{band.label}</p>
              <p className="text-xs text-slate-500">{errorLabels[word.errorType] ?? 'Tipo não identificado'}</p>
            </div>
          </div>

          {/* Guidance */}
          <div className="rounded-xl bg-slate-800/60 border border-slate-700/40 px-4 py-3">
            <p className="text-sm text-slate-300 leading-relaxed">{guidance}</p>
          </div>

          {/* Syllables */}
          {word.syllables.length > 0 && (
            <SyllableSection syllables={word.syllables} />
          )}

          {/* Phonemes */}
          {word.phonemes.length > 0 && (
            <PhonemeSection phonemes={word.phonemes} />
          )}

          {/* No sub-details fallback */}
          {word.syllables.length === 0 && word.phonemes.length === 0 &&
           word.errorType !== 'omission' && word.errorType !== 'insertion' && (
            <p className="text-xs text-slate-600">
              Sílabas e fonemas não foram retornados para esta palavra.
            </p>
          )}

          <div className="h-4" />
        </div>
      </div>
    </div>
  );
}

// ── Syllables ─────────────────────────────────────────────────────────────────

function SyllableSection({ syllables }: { syllables: PronunciationWordDetail['syllables'] }) {
  return (
    <div className="space-y-2">
      <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Sílabas</p>
      <div className="flex flex-wrap gap-2">
        {syllables.map((syl, i) => {
          const score = syl.accuracyScore;
          const color =
            score === null   ? 'text-slate-500 border-slate-700 bg-slate-800/40' :
            score >= 80      ? 'text-green-400 border-green-700 bg-green-900/20' :
            score >= 60      ? 'text-yellow-400 border-yellow-700 bg-yellow-900/20' :
                               'text-red-400 border-red-700 bg-red-900/20';
          const ariaLabel =
            score !== null
              ? `Sílaba ${syl.syllable}, precisão ${Math.round(score)} de 100`
              : `Sílaba ${syl.syllable}, sem nota`;
          return (
            <div
              key={i}
              className={`px-2.5 py-1 rounded border text-sm font-mono ${color}`}
              aria-label={ariaLabel}
            >
              {syl.syllable}
              {score !== null && (
                <span className="ml-1.5 text-xs opacity-70">{Math.round(score)}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Phonemes ──────────────────────────────────────────────────────────────────

function PhonemeSection({ phonemes }: { phonemes: PronunciationWordDetail['phonemes'] }) {
  return (
    <div className="space-y-2">
      <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Fonemas</p>
      <div className="flex flex-wrap gap-2">
        {phonemes.map((ph, i) => {
          const score = ph.accuracyScore;
          const color =
            score === null   ? 'text-slate-500 border-slate-700 bg-slate-800/40' :
            score >= 80      ? 'text-green-400 border-green-700 bg-green-900/20' :
            score >= 60      ? 'text-yellow-400 border-yellow-700 bg-yellow-900/20' :
                               'text-red-400 border-red-700 bg-red-900/20';
          const ariaLabel =
            score !== null
              ? `Fonema ${ph.phoneme}, precisão ${Math.round(score)} de 100`
              : `Fonema ${ph.phoneme}, sem nota`;
          return (
            <div
              key={i}
              className={`px-2.5 py-1 rounded border text-sm font-mono ${color}`}
              aria-label={ariaLabel}
            >
              {ph.phoneme}
              {score !== null && (
                <span className="ml-1.5 text-xs opacity-70">{Math.round(score)}</span>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-[10px] text-slate-600">Símbolos fornecidos pelo Azure Speech.</p>
    </div>
  );
}

// Re-export WORD_BANDS legend colours so the grid can reuse them
export { WORD_BANDS };
