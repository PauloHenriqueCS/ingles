/**
 * Returns a sliding window of the transcript for display as a caption.
 * Shows the last complete sentence plus any in-progress text,
 * so the display updates naturally as speech arrives without showing
 * the full response text at once.
 */
export function getDisplayCaption(fullText: string): string {
  if (!fullText) return '';

  const re = /[.!?]+\s*/g;
  const boundaries: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(fullText)) !== null) {
    boundaries.push(m.index + m[0].length);
  }

  if (boundaries.length === 0) {
    return fullText.trim();
  }

  // Start from three sentences back so the user sees meaningful context
  const lookback = 3;
  const startIdx = boundaries.length >= lookback ? boundaries[boundaries.length - lookback] : 0;
  return fullText.slice(startIdx).trim();
}
