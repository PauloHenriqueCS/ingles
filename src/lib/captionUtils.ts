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

  // Start from the second-to-last boundary (one complete sentence back)
  // so the user always sees context: the last completed sentence + in-progress text
  const startIdx = boundaries.length >= 2 ? boundaries[boundaries.length - 2] : 0;
  return fullText.slice(startIdx).trim();
}
