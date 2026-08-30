import { describe, it, expect } from 'vitest';
import { computeSpotlightLayout, type Insets, type Rect, type Viewport } from '../spotlightGeometry';

const VP: Viewport = { width: 375, height: 667 };
const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
const IOS_INSETS: Insets = { top: 47, right: 0, bottom: 34, left: 0 }; // notch + home indicator

const CARD = { cardWidth: 340, cardHeight: 200 };

describe('computeSpotlightLayout', () => {
  it('centers the card and draws no spotlight when there is no target (welcome/final steps)', () => {
    const layout = computeSpotlightLayout(null, VP, NO_INSETS, CARD);
    expect(layout.mode).toBe('center');
    expect(layout.highlight).toBeNull();
    expect(layout.arrow).toBeNull();
    // roughly centered horizontally + vertically
    expect(layout.card.left).toBeCloseTo((375 - 340) / 2, 0);
    expect(layout.card.top).toBeCloseTo((667 - 200) / 2, 0);
  });

  it('places the card BELOW a target near the top, with an up-pointing arrow', () => {
    const target: Rect = { top: 80, left: 20, width: 335, height: 60 };
    const layout = computeSpotlightLayout(target, VP, NO_INSETS, CARD);
    expect(layout.mode).toBe('below');
    expect(layout.arrow?.dir).toBe('up');
    // card sits under the padded highlight
    expect(layout.card.top).toBeGreaterThan(target.top + target.height);
    expect(layout.highlight).not.toBeNull();
  });

  it('places the card ABOVE a target near the bottom, with a down-pointing arrow', () => {
    const target: Rect = { top: 560, left: 20, width: 335, height: 60 };
    const layout = computeSpotlightLayout(target, VP, NO_INSETS, CARD);
    expect(layout.mode).toBe('above');
    expect(layout.arrow?.dir).toBe('down');
    expect(layout.card.top + CARD.cardHeight).toBeLessThan(target.top);
  });

  it('falls back to a bottom-sheet when neither side has room (tall target / small screen)', () => {
    const target: Rect = { top: 10, left: 0, width: 375, height: 640 }; // fills the screen
    const layout = computeSpotlightLayout(target, VP, NO_INSETS, CARD);
    expect(layout.mode).toBe('bottom-sheet');
    expect(layout.arrow).toBeNull();
    // pinned within the viewport bottom
    expect(layout.card.top + CARD.cardHeight).toBeLessThanOrEqual(VP.height);
  });

  it('never lets the card cross the safe-area insets (notch / home indicator)', () => {
    const target: Rect = { top: 300, left: 0, width: 375, height: 40 };
    const layout = computeSpotlightLayout(target, VP, IOS_INSETS, { cardWidth: 400, cardHeight: 180 });
    const margin = 12;
    expect(layout.card.left).toBeGreaterThanOrEqual(IOS_INSETS.left + margin - 0.01);
    expect(layout.card.left + layout.card.width).toBeLessThanOrEqual(VP.width - IOS_INSETS.right - margin + 0.01);
    expect(layout.card.top).toBeGreaterThanOrEqual(IOS_INSETS.top + margin - 0.01);
    expect(layout.card.top + 180).toBeLessThanOrEqual(VP.height - IOS_INSETS.bottom - margin + 0.01);
  });

  it('clamps the card width to the safe horizontal space', () => {
    const layout = computeSpotlightLayout(null, VP, IOS_INSETS, { cardWidth: 9999, cardHeight: 150 });
    expect(layout.card.width).toBeLessThanOrEqual(VP.width - IOS_INSETS.left - IOS_INSETS.right - 24 + 0.01);
  });

  it('produces a padded highlight rectangle around the target, clamped to the viewport', () => {
    const target: Rect = { top: 5, left: 5, width: 100, height: 40 };
    const layout = computeSpotlightLayout(target, VP, NO_INSETS, CARD);
    expect(layout.highlight).not.toBeNull();
    // padding grows the rect, but never past the viewport edge (0)
    expect(layout.highlight!.left).toBeGreaterThanOrEqual(0);
    expect(layout.highlight!.top).toBeGreaterThanOrEqual(0);
    expect(layout.highlight!.width).toBeGreaterThan(target.width);
  });
});
