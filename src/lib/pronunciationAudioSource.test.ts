import { describe, it, expect } from 'vitest';
import { decideFullTextAudioSource } from './pronunciationAudioSource';

const SHARED = 'blob:shared';
const TTS = 'blob:tts';
const VOICE = 'en-US-AvaMultilingualNeural';

describe('decideFullTextAudioSource — prefer persisted/shared audio, avoid redundant TTS', () => {
  it('uses the shared audio when present and the voice matches (no /api/tts)', () => {
    const d = decideFullTextAudioSource({ sharedAudioUrl: SHARED, sharedAudioVoice: VOICE, currentVoice: VOICE, ttsCachedUrl: null });
    expect(d).toEqual({ kind: 'shared', url: SHARED });
  });

  it('uses the shared audio even if a /api/tts cache also exists (shared wins)', () => {
    const d = decideFullTextAudioSource({ sharedAudioUrl: SHARED, sharedAudioVoice: VOICE, currentVoice: VOICE, ttsCachedUrl: TTS });
    expect(d).toEqual({ kind: 'shared', url: SHARED });
  });

  it('falls back to /api/tts when the user chose a DIFFERENT voice than the shared audio', () => {
    const d = decideFullTextAudioSource({ sharedAudioUrl: SHARED, sharedAudioVoice: VOICE, currentVoice: 'en-US-GuyNeural', ttsCachedUrl: null });
    expect(d).toEqual({ kind: 'fetch-tts' });
  });

  it('uses the /api/tts cache when there is no shared audio', () => {
    const d = decideFullTextAudioSource({ sharedAudioUrl: null, sharedAudioVoice: null, currentVoice: VOICE, ttsCachedUrl: TTS });
    expect(d).toEqual({ kind: 'tts-cache', url: TTS });
  });

  it('fetches /api/tts when there is neither shared audio nor a cache', () => {
    const d = decideFullTextAudioSource({ sharedAudioUrl: null, sharedAudioVoice: null, currentVoice: VOICE, ttsCachedUrl: null });
    expect(d).toEqual({ kind: 'fetch-tts' });
  });

  it('does not use shared audio when the backend returned audio without a voice tag', () => {
    const d = decideFullTextAudioSource({ sharedAudioUrl: SHARED, sharedAudioVoice: null, currentVoice: VOICE, ttsCachedUrl: null });
    expect(d).toEqual({ kind: 'fetch-tts' });
  });
});
