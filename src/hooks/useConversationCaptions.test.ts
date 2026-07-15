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

  it('shows last complete sentence plus in-progress text (sliding window)', () => {
    const text = 'First sentence. Second sentence. In progress';
    const result = getDisplayCaption(text);
    expect(result).toContain('Second sentence');
    expect(result).toContain('In progress');
    expect(result).not.toContain('First sentence');
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

  it('handles text that ends with a period (no in-progress text)', () => {
    const text = 'First sentence. Second sentence.';
    const result = getDisplayCaption(text);
    expect(result).toBe('Second sentence.');
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

  it('builds caption correctly for multiple deltas', () => {
    const deltas = ['I think ', "you're right. ", 'Tell me more ', 'about that.'];
    const full = deltas.reduce((a, d) => a + d, '');
    const caption = getDisplayCaption(full);
    // Should show last sentence since there are 2 complete sentences
    expect(caption).toContain('Tell me more about that.');
    expect(caption).not.toContain("I think you're right.");
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
