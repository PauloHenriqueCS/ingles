import { useState, useCallback, useId } from 'react';
import type { PronunciationWordDetail } from '../lib/pronunciationWordParser';
import { getWordBand, selectWorstWords, WORD_BANDS } from '../lib/pronunciationWordParser';
import PronunciationWordDetailPanel from './PronunciationWordDetailPanel';

interface Props {
  aligned: PronunciationWordDetail[];
  insertions: PronunciationWordDetail[];
}

export default function PronunciationWordGrid({ aligned, insertions }: Props) {
  const [selectedWord, setSelectedWord] = useState<PronunciationWordDetail | null>(null);
  const [returnFocusId, setReturnFocusId] = useState<string | null>(null);
  const legendId = useId();

  const handleSelectWord = useCallback((word: PronunciationWordDetail) => {
    setReturnFocusId(word.id);
    setSelectedWord(word);
  }, []);

  const handleClose = useCallback(() => {
    setSelectedWord(null);
  }, []);

  const worstWords = selectWorstWords(aligned);
  const hasInsertions = insertions.length > 0;
  const hasWorstSection = worstWords.length > 0;

  return (
    <>
      <div className="space-y-4">
        {/* Header */}
        <div>
          <p className="text-xs text-slate-500 font-medium uppercase tracking-wider mb-1">
            Resultado por palavra
          </p>
          <p className="text-xs text-slate-600">
            Toque em uma palavra para ver os detalhes da pronúncia.
          </p>
        </div>

        {/* Legend */}
        <Legend id={legendId} />

        {/* Word flow */}
        <div
          className="flex flex-wrap gap-1.5"
          role="group"
          aria-label="Palavras do texto com resultado de pronúncia"
          aria-describedby={legendId}
        >
          {aligned.map((word) => (
            <WordButton
              key={word.id}
              word={word}
              onClick={handleSelectWord}
            />
          ))}
        </div>

        {/* Worst words to practice */}
        {hasWorstSection && (
          <div className="space-y-2">
            <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">
              Palavras para praticar
            </p>
            <div className="flex flex-wrap gap-1.5">
              {worstWords.map((word) => (
                <WordButton
                  key={`worst-${word.id}`}
                  word={word}
                  onClick={handleSelectWord}
                />
              ))}
            </div>
          </div>
        )}

        {/* Insertions */}
        {hasInsertions && (
          <div className="space-y-2">
            <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">
              Palavras adicionais identificadas
            </p>
            <p className="text-[10px] text-slate-600">
              O Azure identificou estas palavras, mas elas não fazem parte do texto de referência.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {insertions.map((word) => (
                <WordButton
                  key={word.id}
                  word={word}
                  onClick={handleSelectWord}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Detail panel (portal-like overlay) */}
      <PronunciationWordDetailPanel
        word={selectedWord}
        returnFocusId={returnFocusId}
        onClose={handleClose}
      />
    </>
  );
}

// ── Word button ───────────────────────────────────────────────────────────────

interface WordButtonProps {
  word: PronunciationWordDetail;
  onClick: (word: PronunciationWordDetail) => void;
}

function WordButton({ word, onClick }: WordButtonProps) {
  const band = getWordBand(word);
  const ariaLabel = band.makeAriaLabel(word.displayWord, word.accuracyScore);

  return (
    <button
      id={word.id}
      type="button"
      onClick={() => onClick(word)}
      className={`
        px-2 py-1 rounded border text-sm leading-snug
        transition-opacity
        hover:opacity-80 active:opacity-60
        focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-offset-slate-900 focus:ring-blue-500
        min-h-[36px] min-w-[36px]
        ${band.bgClass} ${band.borderClass} ${band.colorClass}
      `}
      aria-label={ariaLabel}
    >
      {word.displayWord}
    </button>
  );
}

// ── Legend ────────────────────────────────────────────────────────────────────

function Legend({ id }: { id: string }) {
  const items: Array<{ band: ReturnType<typeof getWordBand>; text: string }> = [
    { band: WORD_BANDS.good,      text: 'Boa' },
    { band: WORD_BANDS.attention, text: 'Pode melhorar' },
    { band: WORD_BANDS.practice,  text: 'Pratique' },
    { band: WORD_BANDS.omission,  text: 'Não identificada' },
  ];

  return (
    <div
      id={id}
      className="flex flex-wrap gap-x-4 gap-y-1.5"
      aria-label="Legenda das cores de pronúncia"
      role="note"
    >
      {items.map((item) => (
        <div key={item.band.band} className="flex items-center gap-1.5">
          <span
            className={`inline-block w-2.5 h-2.5 rounded-sm border ${item.band.bgClass} ${item.band.borderClass}`}
            aria-hidden="true"
          />
          <span className={`text-[10px] ${item.band.colorClass}`}>{item.text}</span>
        </div>
      ))}
    </div>
  );
}
