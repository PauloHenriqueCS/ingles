/**
 * Pure geometry for the walkthrough spotlight + card placement (§12, §13). No DOM,
 * no React — just math over rectangles so it is fully unit-testable and produces
 * a card that never lands behind the notch / status bar / nav bar or off-screen.
 *
 * All coordinates are viewport pixels (as returned by getBoundingClientRect),
 * suitable for `position: fixed`.
 */

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export type SpotlightMode = 'center' | 'above' | 'below' | 'bottom-sheet';

export interface SpotlightLayout {
  mode: SpotlightMode;
  /** Fixed-position box for the card. */
  card: { left: number; top: number; width: number };
  /** Padded, clamped highlight rectangle to cut out, or null for a centered card. */
  highlight: Rect | null;
  /** Small pointer arrow for above/below placements (null otherwise). */
  arrow: { left: number; dir: 'up' | 'down' } | null;
}

export interface LayoutOptions {
  /** Desired card width (already clamped by the caller to something sensible). */
  cardWidth: number;
  /** Estimated card height (measured or a safe estimate). */
  cardHeight: number;
  /** Padding around the target when drawing the spotlight cutout. */
  spotlightPadding?: number;
  /** Gap between the spotlight and the card. */
  gap?: number;
  /** Minimum distance the card keeps from every safe edge. */
  margin?: number;
}

const clamp = (v: number, lo: number, hi: number): number =>
  hi < lo ? lo : Math.min(Math.max(v, lo), hi);

/**
 * Computes where to place the spotlight cutout and the info card. When `target`
 * is null (welcome / final steps) the card is centered with no cutout. Otherwise
 * it prefers placing the card below the target, then above, and finally falls
 * back to a bottom-sheet card when neither side has room (small screens / tall
 * targets) — the mobile-friendly guarantee in §12.
 */
export function computeSpotlightLayout(
  target: Rect | null,
  viewport: Viewport,
  insets: Insets,
  opts: LayoutOptions,
): SpotlightLayout {
  const pad = opts.spotlightPadding ?? 8;
  const gap = opts.gap ?? 12;
  const margin = opts.margin ?? 12;

  const safeLeft = insets.left + margin;
  const safeRight = viewport.width - insets.right - margin;
  const safeTop = insets.top + margin;
  const safeBottom = viewport.height - insets.bottom - margin;

  const width = Math.min(opts.cardWidth, safeRight - safeLeft);

  // ── Centered card (no spotlight) ───────────────────────────────────────────
  if (!target) {
    const left = clamp((viewport.width - width) / 2, safeLeft, safeRight - width);
    const top = clamp(
      (viewport.height - opts.cardHeight) / 2,
      safeTop,
      Math.max(safeTop, safeBottom - opts.cardHeight),
    );
    return { mode: 'center', card: { left, top, width }, highlight: null, arrow: null };
  }

  // ── Padded, clamped highlight rectangle ────────────────────────────────────
  const hLeft = clamp(target.left - pad, 0, viewport.width);
  const hTop = clamp(target.top - pad, 0, viewport.height);
  const hRight = clamp(target.left + target.width + pad, 0, viewport.width);
  const hBottom = clamp(target.top + target.height + pad, 0, viewport.height);
  const highlight: Rect = {
    left: hLeft,
    top: hTop,
    width: Math.max(0, hRight - hLeft),
    height: Math.max(0, hBottom - hTop),
  };

  const targetCenterX = highlight.left + highlight.width / 2;
  const cardLeft = clamp(targetCenterX - width / 2, safeLeft, Math.max(safeLeft, safeRight - width));

  const spaceBelow = safeBottom - (highlight.top + highlight.height) - gap;
  const spaceAbove = highlight.top - gap - safeTop;

  // Prefer below, then above.
  if (spaceBelow >= opts.cardHeight) {
    const top = highlight.top + highlight.height + gap;
    return {
      mode: 'below',
      card: { left: cardLeft, top, width },
      highlight,
      arrow: { left: clamp(targetCenterX - cardLeft, 16, width - 16), dir: 'up' },
    };
  }
  if (spaceAbove >= opts.cardHeight) {
    const top = highlight.top - gap - opts.cardHeight;
    return {
      mode: 'above',
      card: { left: cardLeft, top, width },
      highlight,
      arrow: { left: clamp(targetCenterX - cardLeft, 16, width - 16), dir: 'down' },
    };
  }

  // ── Bottom-sheet fallback (no room beside the spotlight) ───────────────────
  const sheetWidth = Math.min(opts.cardWidth, safeRight - safeLeft);
  const sheetLeft = clamp((viewport.width - sheetWidth) / 2, safeLeft, safeRight - sheetWidth);
  const sheetTop = Math.max(safeTop, safeBottom - opts.cardHeight);
  return {
    mode: 'bottom-sheet',
    card: { left: sheetLeft, top: sheetTop, width: sheetWidth },
    highlight,
    arrow: null,
  };
}
