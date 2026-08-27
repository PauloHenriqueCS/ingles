/**
 * The caption shows the FULL text of the current response (the portion revealed
 * so far). It is NOT truncated to a tiny window — the caption box is a fixed,
 * scrollable area (see AiSpeechCaption) that auto-scrolls to the bottom, so the
 * currently-spoken words stay visible at the bottom while earlier lines remain
 * scrollable above. This resolves both failure modes we hit before: a tiny
 * window that hides most of a long reply, and a tall block where the current
 * position is ambiguous.
 *
 * A very high safety cap only guards against pathologically long monologues; in
 * that rare case the oldest text is dropped from the left at a word boundary.
 */
export function getDisplayCaption(fullText: string, maxChars = 1200): string {
  if (!fullText) return '';

  const text = fullText.replace(/\s+$/g, '');
  if (text.length <= maxChars) return text.trim();

  // Pathologically long: keep the tail, cut older text at a word boundary.
  let tail = text.slice(text.length - maxChars);
  const firstSpace = tail.indexOf(' ');
  if (firstSpace !== -1 && firstSpace < tail.length - 1) {
    tail = tail.slice(firstSpace + 1);
  }
  return `… ${tail.trim()}`;
}
