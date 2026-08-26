/**
 * Returns a compact sliding window of the transcript for display as a caption.
 * Shows the last few sentences PLUS any in-progress text, and — crucially —
 * bounds the total length so the caption stays ~2 lines and ALWAYS ENDS at the
 * latest (currently-spoken) words. Older text is trimmed from the LEFT, so the
 * last word shown tracks what the tutor is saying right now instead of the
 * caption growing into a tall block where the current position is ambiguous
 * (which read as "out of sync" on long replies).
 *
 * @param maxChars soft cap on the visible caption length (kept ~2 lines). Long
 *   windows are trimmed from the left at a word boundary and prefixed with "…".
 */
export function getDisplayCaption(fullText: string, maxChars = 130): string {
  if (!fullText) return '';

  const re = /[.!?]+\s*/g;
  const boundaries: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(fullText)) !== null) {
    boundaries.push(m.index + m[0].length);
  }

  // Start from up to three sentences back so there's meaningful context…
  const lookback = 3;
  const startIdx = boundaries.length >= lookback ? boundaries[boundaries.length - lookback] : 0;
  let windowed = fullText.slice(startIdx).trim();

  // …but never longer than maxChars: keep the TAIL (the current words) and drop
  // older text from the left at a word boundary, marking the cut with an ellipsis.
  if (windowed.length > maxChars) {
    let tail = windowed.slice(windowed.length - maxChars);
    const firstSpace = tail.indexOf(' ');
    if (firstSpace !== -1 && firstSpace < tail.length - 1) {
      tail = tail.slice(firstSpace + 1);
    }
    windowed = `… ${tail.trimStart()}`;
  }

  return windowed;
}
