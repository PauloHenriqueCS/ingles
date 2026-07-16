import type { ValidatedSentence } from './listening-story-schema';

export class SentenceSegmentationError extends Error {
  readonly code = 'SENTENCE_SEGMENTATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'SentenceSegmentationError';
  }
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// Common abbreviations that should not trigger sentence splits
const ABBREV_RE = /\b(Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|vs|etc)\./gi;
const ABBREV_PLACEHOLDER = '\x01';

function splitIntoSentences(paragraph: string): string[] {
  // Temporarily replace abbreviation periods to avoid false splits
  const abbrevMatches: string[] = [];
  const marked = paragraph.replace(ABBREV_RE, (match) => {
    abbrevMatches.push(match);
    return match.slice(0, -1) + ABBREV_PLACEHOLDER;
  });

  // Split at sentence-ending punctuation followed by whitespace + uppercase or quote
  const parts: string[] = [];
  let lastIndex = 0;

  const re = /([.?!]+)\s+(?=[A-Z"'"'])/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(marked)) !== null) {
    const endPos = match.index + match[1].length; // after punctuation, before whitespace
    const part = marked.slice(lastIndex, endPos);
    if (part.trim()) parts.push(part);
    lastIndex = match.index + match[0].length; // skip whitespace
  }

  const last = marked.slice(lastIndex);
  if (last.trim()) parts.push(last);

  // Restore abbreviation periods
  let abbrevIdx = 0;
  return parts.map(p =>
    p.replace(new RegExp(ABBREV_PLACEHOLDER, 'g'), () => {
      const orig = abbrevMatches[abbrevIdx++];
      return orig ? orig.slice(-1) : '.';
    })
  );
}

/**
 * Segments a block's text_en into ValidatedSentence[] deterministically.
 * Validates that joining all sentences reproduces the original text.
 */
export function segmentListeningText(textEn: string, blockOrder: 1 | 2): ValidatedSentence[] {
  const paragraphs = textEn.split(/\n+/).map(p => p.trim()).filter(p => p.length > 0);
  const normalizedParagraphs = paragraphs.length > 0 ? paragraphs : [textEn.trim()];

  const sentences: ValidatedSentence[] = [];
  let sentenceOrder = 1;

  for (let pIdx = 0; pIdx < normalizedParagraphs.length; pIdx++) {
    const paragraphOrder = pIdx + 1;
    const rawSentences = splitIntoSentences(normalizedParagraphs[pIdx]);

    for (const raw of rawSentences) {
      const text = raw.trim();
      if (!text) continue;

      sentences.push({
        sentenceKey: `b${blockOrder}s${String(sentenceOrder).padStart(2, '0')}`,
        sentenceOrder,
        paragraphOrder,
        speaker: null,
        textEn: text,
      });
      sentenceOrder++;
    }
  }

  if (sentences.length === 0) {
    throw new SentenceSegmentationError(`Block ${blockOrder}: no sentences could be extracted from text`);
  }

  // Validate reconstruction
  const reconstructed = normalizeWhitespace(sentences.map(s => s.textEn).join(' '));
  const original = normalizeWhitespace(textEn);

  if (reconstructed !== original) {
    throw new SentenceSegmentationError(
      `Block ${blockOrder}: sentence reconstruction does not match original text ` +
      `(first 80 chars: "${original.slice(0, 80)}")`
    );
  }

  return sentences;
}
