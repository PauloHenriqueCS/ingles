/**
 * SERVER-ONLY — never import from client-side bundles.
 *
 * Deterministic, server-only character counting for Azure Text-to-Speech
 * billing, per Microsoft's documented rule (verified 2026-07-17):
 * https://learn.microsoft.com/en-us/azure/ai-services/speech-service/text-to-speech
 *
 *   "Billing is based on the total number of characters in each successfully
 *    processed request. [...] Text passed to the text to speech feature in
 *    the SSML body of the request; all markup within the text field of the
 *    request body in the SSML format, EXCEPT for <speak> and <voice> tags;
 *    letters, punctuation, spaces, tabs, markup, and all white-space
 *    characters; every code point defined in Unicode."
 *
 * So: count every Unicode code point in the SSML body actually sent to
 * Azure, EXCLUDING only the <speak ...>/</speak> and <voice ...>/</voice>
 * tag occurrences (their attributes included) — every other tag (e.g.
 * <prosody>, <break>, <bookmark>) counts as billable text.
 *
 * NOT implemented: Microsoft additionally doubles each CJK character
 * (Chinese/Japanese kanji/Korean hanja) for billing. This app only ever
 * synthesizes English (en-US) content, so that rule is intentionally left
 * out — documented here rather than silently guessed at.
 *
 * This function never receives or returns the original text/SSML for
 * persistence — callers must only pass the resulting number to the Gateway.
 */

const SPEAK_OR_VOICE_TAG = /<\/?(?:speak|voice)\b[^>]*>/gi;

/**
 * Counts the Azure-billable characters in an SSML body: every Unicode code
 * point except the <speak>/<voice> tag markup itself.
 */
export function countTtsSsmlCharacters(ssml: string): number {
  const withoutSpeakAndVoiceTags = ssml.replace(SPEAK_OR_VOICE_TAG, '');
  // Array.from iterates by Unicode code point, not UTF-16 code unit, so
  // surrogate pairs (e.g. emoji) count as one character, matching "every
  // code point defined in Unicode" rather than JS string .length semantics.
  return Array.from(withoutSpeakAndVoiceTags).length;
}

/**
 * Counts billable characters for plain text (no SSML wrapper) sent as-is to
 * a TTS request body. Same code-point-based counting rule.
 */
export function countTtsPlainTextCharacters(text: string): number {
  return Array.from(text).length;
}
