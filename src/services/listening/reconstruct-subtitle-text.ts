import type { EnglishCueDraft } from './listening-subtitle-schema';

/**
 * Normalises text for reconstruction comparison:
 * - collapses whitespace
 * - trims
 * - normalises straight vs curly quotes (ignores controlled differences)
 * Differences in actual words are NOT ignored.
 */
export function normaliseForReconstruction(text: string): string {
  return text
    .replace(/[‘’]/g, "'")   // curly single quotes → straight
    .replace(/[“”]/g, '"')   // curly double quotes → straight
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Validates that concatenating all English cue texts reconstructs the
 * canonical block text exactly (after normalisation).
 *
 * Throws if the reconstruction does not match.
 */
export function validateEnglishReconstruction(
  blockTextEn: string,
  cues: EnglishCueDraft[],
): void {
  const reconstructed = normaliseForReconstruction(
    cues.map(c => c.text).join(' ')
  );
  const canonical = normaliseForReconstruction(blockTextEn);

  if (reconstructed !== canonical) {
    // Find first differing position for a useful error message
    let diffPos = 0;
    const minLen = Math.min(reconstructed.length, canonical.length);
    while (diffPos < minLen && reconstructed[diffPos] === canonical[diffPos]) {
      diffPos++;
    }
    const context = canonical.slice(Math.max(0, diffPos - 20), diffPos + 40);
    throw new Error(
      `English cue reconstruction mismatch near position ${diffPos}: "…${context}…"`
    );
  }
}
