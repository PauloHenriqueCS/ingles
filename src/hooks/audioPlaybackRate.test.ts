import { describe, it, expect } from 'vitest';
import { applyPlaybackRate } from './audioPlaybackRate';

/**
 * Browser-accurate fake of the parts of HTMLMediaElement that matter for the
 * playback-rate bug. This repo's vitest env is 'node' (no jsdom), so we model
 * the ONE browser behaviour that causes the bug: when a new resource is selected
 * (a `src` assignment), the media element load algorithm resets `playbackRate`
 * back to `defaultPlaybackRate`.
 *
 * These tests therefore assert the value effectively applied to the ELEMENT
 * (not merely a React state variable) — which is what actually reaches the
 * decoder — across a Parte 1 → Parte 2 transition.
 */
class FakeMediaElement {
  playbackRate = 1;
  defaultPlaybackRate = 1;
  private _src = '';

  set src(value: string) {
    this._src = value;
    // Media element load algorithm: on resource (re)selection, playbackRate is
    // reset to defaultPlaybackRate. In a real browser this is async; the effect
    // on the eventually-observed value is identical, so we model it directly.
    this.playbackRate = this.defaultPlaybackRate;
  }
  get src(): string {
    return this._src;
  }
}

const SPEEDS = [0.75, 0.9, 1.0, 1.1, 1.25];

describe('applyPlaybackRate — survives Parte 1 → Parte 2 src swap', () => {
  it('Cenário 1: 1× on Parte 1 stays 1× after advancing to Parte 2', () => {
    const audio = new FakeMediaElement();
    applyPlaybackRate(audio, 1.0); // Parte 1 default
    expect(audio.playbackRate).toBe(1.0);

    audio.src = 'part-2-url'; // advance (same element, src swap)
    applyPlaybackRate(audio, 1.0); // re-applied by the fix
    expect(audio.playbackRate).toBe(1.0);
  });

  it('Cenário 2: selecting 0.75× on Parte 1 sets the element to 0.75×', () => {
    const audio = new FakeMediaElement();
    applyPlaybackRate(audio, 0.75);
    expect(audio.playbackRate).toBe(0.75);
  });

  it('Cenário 3: with 0.75× selected, the element still plays 0.75× on Parte 2', () => {
    const audio = new FakeMediaElement();
    applyPlaybackRate(audio, 0.75); // user picks 0.75× on Parte 1

    audio.src = 'part-2-url'; // handleStoryAdvance swaps src...
    applyPlaybackRate(audio, 0.75); // ...and re-applies the selected rate

    expect(audio.playbackRate).toBe(0.75);
    // And the async reset (were it to fire again) now lands on 0.75, not 1.0,
    // because defaultPlaybackRate was pinned too:
    expect(audio.defaultPlaybackRate).toBe(0.75);
    audio.src = 'part-2-url-refreshed'; // e.g. signed-URL refresh mid-part
    expect(audio.playbackRate).toBe(0.75);
  });

  it('Cenário 4: 1.25× is preserved across the Parte 1 → Parte 2 swap', () => {
    const audio = new FakeMediaElement();
    applyPlaybackRate(audio, 1.25);
    expect(audio.playbackRate).toBe(1.25);

    audio.src = 'part-2-url';
    applyPlaybackRate(audio, 1.25);
    expect(audio.playbackRate).toBe(1.25);
  });

  it('Cenário 5: rate is preserved if the flow returns from Parte 2 to Parte 1', () => {
    const audio = new FakeMediaElement();
    applyPlaybackRate(audio, 0.9);

    audio.src = 'part-2-url';
    applyPlaybackRate(audio, 0.9);
    expect(audio.playbackRate).toBe(0.9);

    audio.src = 'part-1-url'; // hypothetical back-navigation, same element
    applyPlaybackRate(audio, 0.9);
    expect(audio.playbackRate).toBe(0.9);
  });

  it('Cenário 6: changing rate while on Parte 2 takes effect immediately', () => {
    const audio = new FakeMediaElement();
    audio.src = 'part-2-url';
    applyPlaybackRate(audio, 1.1);
    expect(audio.playbackRate).toBe(1.1);
  });

  it('regression proof: setting only playbackRate (the OLD behaviour) reverts on src swap', () => {
    const audio = new FakeMediaElement();
    audio.playbackRate = 0.75; // old setRate — no defaultPlaybackRate
    expect(audio.playbackRate).toBe(0.75);
    audio.src = 'part-2-url'; // browser resets to defaultPlaybackRate (1.0)
    expect(audio.playbackRate).toBe(1.0); // <-- the bug, reproduced
  });

  it('all five speeds stick across a src swap when applied via applyPlaybackRate', () => {
    for (const rate of SPEEDS) {
      const audio = new FakeMediaElement();
      applyPlaybackRate(audio, rate);
      audio.src = 'next-part';
      applyPlaybackRate(audio, rate);
      expect(audio.playbackRate).toBe(rate);
      expect(audio.defaultPlaybackRate).toBe(rate);
    }
  });
});
