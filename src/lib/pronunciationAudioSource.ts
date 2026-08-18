/**
 * Decides which audio source the Pronunciation full-text "listen" button should
 * use, so the persisted/shared reference audio returned by the backend
 * (generate-text) is the PREFERRED source and a redundant Azure TTS call is
 * avoided whenever valid cached audio exists.
 *
 * Rule:
 *   - Use the shared/persisted audio when present AND it was synthesized with the
 *     voice the user is currently using (the default case). This is what prevents
 *     "backend returned valid cached audio → frontend ignores it → /api/tts →
 *     unnecessary Azure call".
 *   - Otherwise (user picked a different voice, or there is no shared audio) use
 *     the /api/tts cache if present, else fetch /api/tts as a fallback.
 */
export type FullTextAudioDecision =
  | { kind: 'shared'; url: string }
  | { kind: 'tts-cache'; url: string }
  | { kind: 'fetch-tts' };

export function decideFullTextAudioSource(input: {
  sharedAudioUrl: string | null;
  sharedAudioVoice: string | null;
  currentVoice: string;
  ttsCachedUrl: string | null;
}): FullTextAudioDecision {
  if (
    input.sharedAudioUrl &&
    input.sharedAudioVoice &&
    input.sharedAudioVoice === input.currentVoice
  ) {
    return { kind: 'shared', url: input.sharedAudioUrl };
  }
  if (input.ttsCachedUrl) return { kind: 'tts-cache', url: input.ttsCachedUrl };
  return { kind: 'fetch-tts' };
}

/** Converts base64 audio (from the backend) into a playable object URL. Browser-only. */
export function base64AudioToObjectUrl(base64: string, mimeType: string): string {
  const chars = atob(base64);
  const bytes = new Uint8Array(chars.length);
  for (let i = 0; i < chars.length; i++) bytes[i] = chars.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}
