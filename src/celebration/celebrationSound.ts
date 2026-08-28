/**
 * Celebration sound effects, synthesized programmatically with the Web Audio API
 * — no bundled MP3/WAV assets and no third-party audio library. Two short,
 * pleasant profiles:
 *
 *   - activity-complete: a quick two-note "pling" (~350ms).
 *   - day-complete:      a richer ascending arpeggio that resolves up (~850ms).
 *
 * Design rules:
 *   - Fail-safe: any failure (no AudioContext, autoplay blocked, suspended
 *     context) is swallowed. Sound must NEVER break the activity completion.
 *   - Lazy: the AudioContext is created on first use (inside the user gesture
 *     that finished the activity) and reused, so mobile autoplay policies are
 *     satisfied and there is no idle audio graph.
 *   - Cheap: pure oscillators + gain envelopes, so there is no perceptible delay.
 *
 * A single module-level mute flag is exposed so a future settings toggle can turn
 * completion sounds off without touching any call site.
 */

type Ctor = typeof AudioContext;

let ctx: AudioContext | null = null;
let muted = false;

/** Turn completion sounds on/off globally (wire a future settings toggle here). */
export function setCelebrationSoundMuted(value: boolean): void {
  muted = value;
}

export function isCelebrationSoundMuted(): boolean {
  return muted;
}

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctx: Ctor | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext;
  if (!Ctx) return null;
  try {
    if (!ctx) ctx = new Ctx();
    // A context can be 'suspended' until a gesture resumes it. Best-effort.
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

interface Note {
  /** Frequency in Hz. */
  freq: number;
  /** Start offset from "now", in seconds. */
  at: number;
  /** Duration in seconds. */
  dur: number;
  /** Peak gain (0..1). */
  gain: number;
  type?: OscillatorType;
}

function playNotes(notes: Note[]): void {
  const audio = getContext();
  if (!audio) return;
  try {
    const now = audio.currentTime;
    for (const n of notes) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = n.type ?? 'sine';
      osc.frequency.value = n.freq;

      const start = now + n.at;
      const end = start + n.dur;
      // Fast attack, smooth exponential release — a soft "pling", not a beep.
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(n.gain, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);

      osc.connect(gain);
      gain.connect(audio.destination);
      osc.start(start);
      osc.stop(end + 0.02);
    }
  } catch {
    /* never let audio break the flow */
  }
}

/** Short, bright two-note confirmation. */
export function playActivityCompleteSound(): void {
  if (muted) return;
  // E6 → B6, a clean rising fifth.
  playNotes([
    { freq: 1318.51, at: 0, dur: 0.16, gain: 0.16, type: 'triangle' },
    { freq: 1975.53, at: 0.09, dur: 0.22, gain: 0.14, type: 'sine' },
  ]);
}

/** Richer ascending arpeggio that resolves an octave up — a "you did it" flourish. */
export function playDayCompleteSound(): void {
  if (muted) return;
  // C5 – E5 – G5 – C6, then a sparkle on top.
  playNotes([
    { freq: 523.25, at: 0.0, dur: 0.2, gain: 0.16, type: 'triangle' },
    { freq: 659.25, at: 0.12, dur: 0.2, gain: 0.16, type: 'triangle' },
    { freq: 783.99, at: 0.24, dur: 0.24, gain: 0.16, type: 'triangle' },
    { freq: 1046.5, at: 0.38, dur: 0.42, gain: 0.18, type: 'sine' },
    { freq: 1567.98, at: 0.46, dur: 0.36, gain: 0.1, type: 'sine' },
  ]);
}
