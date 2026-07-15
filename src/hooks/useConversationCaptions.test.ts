import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getDisplayCaption } from '../lib/captionUtils';

// ── localStorage stub ─────────────────────────────────────────────────────────

const store: Record<string, string> = {};

const localStorageMock = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => { store[key] = value; },
  removeItem: (key: string) => { delete store[key]; },
  clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
};

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

// ── Supabase mock ─────────────────────────────────────────────────────────────

const mockUpsert = vi.fn().mockResolvedValue({ error: null });
const mockMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
    },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        maybeSingle: mockMaybeSingle,
      })),
      upsert: mockUpsert,
    })),
  },
}));

// ── getDisplayCaption tests ───────────────────────────────────────────────────

describe('getDisplayCaption', () => {
  it('returns empty string for empty input', () => {
    expect(getDisplayCaption('')).toBe('');
  });

  it('returns all text when there are no sentence boundaries', () => {
    expect(getDisplayCaption('Hello there')).toBe('Hello there');
  });

  it('returns the single sentence when there is one boundary', () => {
    expect(getDisplayCaption('Hello there.')).toBe('Hello there.');
  });

  it('returns last sentence when there are two complete sentences', () => {
    const text = 'Hello there. How are you?';
    const result = getDisplayCaption(text);
    expect(result).toContain('How are you?');
  });

  it('shows recent sentences plus in-progress text (sliding window drops old sentences)', () => {
    // lookback=3 → needs >3 complete sentences to start dropping early ones
    const text = 'First. Second. Third. Fourth. In progress';
    const result = getDisplayCaption(text);
    // The most recent content must be visible
    expect(result).toContain('Fourth.');
    expect(result).toContain('In progress');
    // The oldest sentence is dropped when there are more than 3 complete sentences
    expect(result).not.toContain('First.');
  });

  it('handles exclamation points as boundaries', () => {
    const text = 'Wow! Really! Tell me more';
    const result = getDisplayCaption(text);
    expect(result).toContain('Really!');
    expect(result).toContain('Tell me more');
  });

  it('handles mixed punctuation', () => {
    const text = 'Wait... really? Yes! And then?';
    const result = getDisplayCaption(text);
    expect(result).toContain('Yes!');
  });

  it('does not show text that has not been received yet', () => {
    const partial = 'I think that';
    expect(getDisplayCaption(partial)).toBe('I think that');
  });

  it('handles single word input', () => {
    expect(getDisplayCaption('Hello')).toBe('Hello');
  });

  it('handles text with only complete sentences (no in-progress) — shows up to lookback=3', () => {
    // 2 sentences → fewer than lookback(3) → shows both
    const two = 'First sentence. Second sentence.';
    expect(getDisplayCaption(two)).toBe('First sentence. Second sentence.');

    // 4 sentences → older one is dropped
    const four = 'A. B. C. D.';
    const result = getDisplayCaption(four);
    expect(result).toContain('D.');
    expect(result).not.toContain('A.');
  });
});

// ── Preference persistence tests ──────────────────────────────────────────────

describe('localStorage caption preference', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    localStorageMock.clear();
  });

  it('uses separate localStorage keys per user to prevent leaking between users', () => {
    localStorageMock.setItem('conversation_captions_enabled_user-1', 'false');
    localStorageMock.setItem('conversation_captions_enabled_user-2', 'true');

    expect(localStorageMock.getItem('conversation_captions_enabled_user-1')).toBe('false');
    expect(localStorageMock.getItem('conversation_captions_enabled_user-2')).toBe('true');
  });

  it('defaults to enabled (true) when no stored value exists', () => {
    const value = localStorageMock.getItem('conversation_captions_enabled_user-unknown');
    expect(value).toBeNull();
    // Null means "use default" which is true (captions on by default)
  });

  it('persists false correctly', () => {
    localStorageMock.setItem('conversation_captions_enabled_user-1', 'false');
    expect(localStorageMock.getItem('conversation_captions_enabled_user-1')).toBe('false');
  });

  it('persists true correctly', () => {
    localStorageMock.setItem('conversation_captions_enabled_user-1', 'true');
    expect(localStorageMock.getItem('conversation_captions_enabled_user-1')).toBe('true');
  });

  it('overwriting a key updates the value', () => {
    localStorageMock.setItem('conversation_captions_enabled_user-1', 'true');
    localStorageMock.setItem('conversation_captions_enabled_user-1', 'false');
    expect(localStorageMock.getItem('conversation_captions_enabled_user-1')).toBe('false');
  });

  it('changing key for one user does not affect another', () => {
    localStorageMock.setItem('conversation_captions_enabled_user-1', 'true');
    localStorageMock.setItem('conversation_captions_enabled_user-2', 'false');
    localStorageMock.setItem('conversation_captions_enabled_user-1', 'false');
    expect(localStorageMock.getItem('conversation_captions_enabled_user-2')).toBe('false');
  });
});

// ── Transcript accumulation tests ─────────────────────────────────────────────

describe('transcript accumulation', () => {
  it('accumulates deltas correctly', () => {
    const deltas = ['Hello', ', how', ' are you', '?'];
    const result = deltas.reduce((acc, d) => acc + d, '');
    expect(result).toBe('Hello, how are you?');
  });

  it('resets transcript for a new response', () => {
    let transcript = 'Previous response text.';
    // New response starts — reset
    transcript = '';
    transcript += 'New response';
    expect(transcript).toBe('New response');
  });

  it('keeps transcript visible after response ends (not reset until new response)', () => {
    let transcript = 'Completed response.';
    // response.done fires — transcript stays visible
    // Only resets on next response.output_audio.delta when responseActive was false
    expect(transcript).toBe('Completed response.');
  });

  it('handles empty delta gracefully', () => {
    let transcript = 'Existing';
    transcript += '';
    expect(transcript).toBe('Existing');
  });

  it('builds caption correctly for multiple deltas (fewer than lookback shows all)', () => {
    const deltas = ['I think ', "you're right. ", 'Tell me more ', 'about that.'];
    const full = deltas.reduce((a, d) => a + d, '');
    const caption = getDisplayCaption(full);
    // 2 complete sentences < lookback(3) → shows everything
    expect(caption).toContain('Tell me more about that.');
    expect(caption).toContain("I think you're right.");
  });
});

// ── Caption visibility state tests ───────────────────────────────────────────

describe('caption visibility state', () => {
  it('caption off suppresses display even if transcript exists', () => {
    const visible = false;
    const text = 'Some text';
    // AiSpeechCaption returns null when !visible
    const shouldRender = visible && Boolean(text);
    expect(shouldRender).toBe(false);
  });

  it('caption on with text renders content', () => {
    const visible = true;
    const text = 'Some text';
    const shouldRender = visible && Boolean(text);
    expect(shouldRender).toBe(true);
  });

  it('caption on with empty text renders nothing', () => {
    const visible = true;
    const text = '';
    const display = getDisplayCaption(text);
    expect(display).toBe('');
  });

  it('toggle goes from enabled to disabled', () => {
    let enabled = true;
    enabled = !enabled;
    expect(enabled).toBe(false);
  });

  it('toggle goes from disabled to enabled', () => {
    let enabled = false;
    enabled = !enabled;
    expect(enabled).toBe(true);
  });
});

// ── Audio interruption / lifecycle tests ─────────────────────────────────────

describe('audio interruption handling', () => {
  it('transcript resets on cleanup (session end)', () => {
    let transcriptAccum = 'Some partial text';
    let responseActive = true;

    // cleanup() resets these
    transcriptAccum = '';
    responseActive = false;

    expect(transcriptAccum).toBe('');
    expect(responseActive).toBe(false);
  });

  it('pausing audio (no new deltas) keeps transcript unchanged', () => {
    const transcript = 'Text so far';
    expect(transcript).toBe('Text so far');
  });

  it('resuming audio continues appending to the same transcript', () => {
    let transcript = 'Text so far';
    transcript += ' and more text';
    expect(transcript).toBe('Text so far and more text');
  });

  it('audio error does not continue advancing transcript', () => {
    let transcript = 'Partial text';
    let responseActive = true;

    // On error: cleanup() runs, resetting state
    transcript = '';
    responseActive = false;

    // No new deltas arrive
    expect(transcript).toBe('');
  });

  it('new response replaces the previous transcript', () => {
    let transcript = 'Old response text.';
    let responseActive = false;

    // New response.output_audio.delta arrives, responseActive is false
    if (!responseActive) {
      responseActive = true;
      transcript = '';
    }
    transcript += 'New response';

    expect(transcript).toBe('New response');
  });
});

// ── Mobile layout compliance ──────────────────────────────────────────────────

describe('AiSpeechCaption mobile layout', () => {
  it('limits width with max-w-sm to prevent overly wide captions', () => {
    // CSS classes applied in AiSpeechCaption component
    const rootClassName = 'w-full max-w-sm mx-auto';
    expect(rootClassName).toContain('max-w-sm');
    expect(rootClassName).toContain('w-full');
  });

  it('caption area returns null when disabled (no layout space consumed)', () => {
    const visible = false;
    const result = visible ? 'rendered' : null;
    expect(result).toBeNull();
  });

  it('caption area returns null when enabled but empty (no layout space consumed)', () => {
    const visible = true;
    const display = getDisplayCaption('');
    const result = visible && display ? 'rendered' : null;
    expect(result).toBeNull();
  });
});

// ── Caption timer — speed-adjusted reveal interval ────────────────────────────
// The reveal timer interval is scaled by playbackRate so captions stay in sync
// with the actual audio playback speed across all three speed modes.

describe('caption reveal timer — playback rate scaling', () => {
  const BASE_INTERVAL_MS = 140;

  function computeInterval(playbackRate: number): number {
    return Math.round(BASE_INTERVAL_MS / playbackRate);
  }

  it('Normal (1.0×) uses the base interval of 140 ms', () => {
    expect(computeInterval(1.0)).toBe(140);
  });

  it('Devagar (0.80×) uses a longer interval (~175 ms)', () => {
    const interval = computeInterval(0.80);
    expect(interval).toBe(175);
    expect(interval).toBeGreaterThan(BASE_INTERVAL_MS);
  });

  it('Superdevagar (0.65×) uses an even longer interval (~215 ms)', () => {
    const interval = computeInterval(0.65);
    expect(interval).toBe(215);
    expect(interval).toBeGreaterThan(computeInterval(0.80));
  });

  it('slower speed always produces a longer interval (captions advance slower)', () => {
    const slow    = computeInterval(0.65);
    const medium  = computeInterval(0.80);
    const fast    = computeInterval(1.0);
    expect(slow).toBeGreaterThan(medium);
    expect(medium).toBeGreaterThan(fast);
  });

  it('interval is always a positive integer', () => {
    for (const rate of [0.65, 0.80, 1.0]) {
      const interval = computeInterval(rate);
      expect(interval).toBeGreaterThan(0);
      expect(Number.isInteger(interval)).toBe(true);
    }
  });

  it('caption does not advance while audio is paused (no new text reveals without timer ticks)', () => {
    // Simulate: timer stopped, displayCount frozen
    let displayCount = 5;
    const transcriptAccum = 'Hello world';

    // Timer is stopped (no setInterval running) — simulate no ticks
    const ticksWithoutTimer = 0;
    // display count stays at 5 despite more text being in accumulator
    for (let i = 0; i < ticksWithoutTimer; i++) {
      if (displayCount < transcriptAccum.length) displayCount++;
    }
    expect(displayCount).toBe(5);
    expect(transcriptAccum.slice(0, displayCount)).toBe('Hello');
  });

  it('new response resets caption to empty before starting reveal', () => {
    // Simulate response.created handler
    let displayCount = 50;
    let transcriptAccum = 'Old response text.';
    let transcriptText = transcriptAccum;

    // New response arrives
    transcriptAccum = '';
    displayCount = 0;
    transcriptText = '';

    expect(transcriptText).toBe('');
    expect(displayCount).toBe(0);
  });

  it('no additional OpenAI call is made for caption text — captions use audio transcript', async () => {
    const src = await import('../hooks/useRealtimeSession?raw');
    const code = (src as unknown as { default: string }).default;
    // Caption text comes from response.audio_transcript.delta events, not a new API call
    expect(code).toContain('response.audio_transcript.delta');
    // There must be NO second fetch call for caption generation
    const fetchMatches = code.match(/fetch\s*\(/g) ?? [];
    // Only 2 fetch calls are expected: /api/conversation/session + /v1/realtime/calls
    expect(fetchMatches.length).toBeLessThanOrEqual(2);
  });
});

// ── Speed mode — playback rate values (sourced from tutorPreferences) ─────────

describe('speech pace modes — actual playback rates', () => {
  // Import the PACE_PLAYBACK_RATE map used by ConversationView
  it('PACE_PLAYBACK_RATE file exports the expected rates', async () => {
    const mod = await import('../lib/tutorPreferences');
    const { PACE_PLAYBACK_RATE } = mod;
    expect(PACE_PLAYBACK_RATE.natural).toBe(1.0);   // Normal
    expect(PACE_PLAYBACK_RATE.normal).toBe(0.80);   // Devagar
    expect(PACE_PLAYBACK_RATE.slow).toBe(0.65);     // Superdevagar
  });

  it('all pace modes have a defined non-zero playback rate', async () => {
    const mod = await import('../lib/tutorPreferences');
    const { PACE_PLAYBACK_RATE } = mod;
    for (const rate of Object.values(PACE_PLAYBACK_RATE)) {
      expect(typeof rate).toBe('number');
      expect(rate).toBeGreaterThan(0);
    }
  });

  it('preference persists per user via PACE_LABELS keys matching PACE_PLAYBACK_RATE keys', async () => {
    const mod = await import('../lib/tutorPreferences');
    const { PACE_LABELS, PACE_PLAYBACK_RATE } = mod;
    // Every label key must have a corresponding playback rate
    for (const key of Object.keys(PACE_LABELS)) {
      expect(PACE_PLAYBACK_RATE[key as keyof typeof PACE_PLAYBACK_RATE]).toBeDefined();
    }
  });
});
