import type { ListeningSentence } from '../../domain/listening/listening-types';

/** Escapes characters that have special meaning in XML. */
export function escapeXmlForSsml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Unescapes XML entities back to plain text. */
function unescapeXml(text: string): string {
  return text
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

/** Normalises whitespace for spoken-text comparison. */
function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Strips all XML tags and unescapes entities to recover the plain spoken text
 * from an SSML document. `<break>` and `<bookmark>` produce no speech.
 */
export function extractSpokenTextFromSsml(ssml: string): string {
  const stripped = ssml.replace(/<[^>]+>/g, ' ');
  return normalise(unescapeXml(stripped));
}

/**
 * Returns the normalised canonical text that the SSML must reproduce.
 * The canonical source is always `listening_sentences.text_en` in sentence order.
 */
export function canonicalSpokenText(sentences: Pick<ListeningSentence, 'textEn'>[]): string {
  return normalise(sentences.map(s => s.textEn).join(' '));
}

/**
 * Validates that the SSML reproduces the canonical sentence text exactly.
 * Throws if any word has been added, removed, or changed.
 */
export function validateSpokenTextPreservation(
  ssml: string,
  sentences: Pick<ListeningSentence, 'textEn'>[],
): void {
  const extracted = extractSpokenTextFromSsml(ssml);
  const canonical = canonicalSpokenText(sentences);
  if (extracted !== canonical) {
    let diffPos = 0;
    const minLen = Math.min(extracted.length, canonical.length);
    while (diffPos < minLen && extracted[diffPos] === canonical[diffPos]) diffPos++;
    const ctx = canonical.slice(Math.max(0, diffPos - 20), diffPos + 40);
    throw new Error(
      `SSML spoken text does not match canonical text near position ${diffPos}: "…${ctx}…"`
    );
  }
}
