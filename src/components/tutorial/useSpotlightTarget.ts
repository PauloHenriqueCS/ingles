import { useEffect, useState } from 'react';
import type { Insets, Rect } from './spotlightGeometry';
import type { TutorialAnchor } from './tutorialSteps';

const ZERO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** Reads the live safe-area insets by resolving env(safe-area-inset-*) through a probe. */
function readSafeInsets(): Insets {
  if (typeof document === 'undefined') return ZERO_INSETS;
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
    'padding-top:env(safe-area-inset-top);padding-right:env(safe-area-inset-right);' +
    'padding-bottom:env(safe-area-inset-bottom);padding-left:env(safe-area-inset-left);';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const insets: Insets = {
    top: parseFloat(cs.paddingTop) || 0,
    right: parseFloat(cs.paddingRight) || 0,
    bottom: parseFloat(cs.paddingBottom) || 0,
    left: parseFloat(cs.paddingLeft) || 0,
  };
  document.body.removeChild(probe);
  return insets;
}

function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

function rectsDiffer(a: Rect | null, b: Rect | null): boolean {
  if (a === b) return false;
  if (!a || !b) return true;
  return (
    Math.abs(a.top - b.top) > 0.5 ||
    Math.abs(a.left - b.left) > 0.5 ||
    Math.abs(a.width - b.width) > 0.5 ||
    Math.abs(a.height - b.height) > 0.5
  );
}

export interface SpotlightTarget {
  /** Live rect of the anchored element, or null (anchor is null, or not found). */
  rect: Rect | null;
  /** Live safe-area insets. */
  insets: Insets;
  /** True once the target has been located (or the step is centered / anchor missing). */
  ready: boolean;
}

/**
 * Locates the `[data-tour="…"]` element for the active step, scrolls it into view
 * when needed, and keeps its rect in sync through smooth scroll, resize,
 * orientation changes and asynchronous Home layout shifts (entitlements / focus /
 * recommended card loading — §13). A short rAF window follows the smooth-scroll
 * settle; after that a ResizeObserver + window listeners keep it aligned. Never
 * throws if the element is missing (rect stays null → the caller shows a centered
 * card instead of a broken spotlight).
 */
export function useSpotlightTarget(anchor: TutorialAnchor, active: boolean): SpotlightTarget {
  const [rect, setRect] = useState<Rect | null>(null);
  const [insets, setInsets] = useState<Insets>(ZERO_INSETS);
  const [ready, setReady] = useState<boolean>(false);

  useEffect(() => {
    if (!active) return;
    setInsets(readSafeInsets());
  }, [active]);

  useEffect(() => {
    if (!active) {
      setRect(null);
      setReady(false);
      return;
    }

    // Centered step (no anchor) — nothing to track.
    if (!anchor) {
      setRect(null);
      setReady(true);
      return;
    }

    let cancelled = false;
    let rafId = 0;
    let followUntil = 0;
    let last: Rect | null = null;

    const el = document.querySelector<HTMLElement>(`[data-tour="${anchor}"]`);
    if (!el) {
      // Anchor not on screen — fail soft to a centered card, never a broken hole.
      setRect(null);
      setReady(true);
      return;
    }

    const measure = () => {
      if (cancelled) return;
      const next = rectOf(el);
      if (rectsDiffer(last, next)) {
        last = next;
        setRect(next);
      }
      setReady(true);
    };

    // Follow the smooth scroll / layout settle for a short window, then stop the
    // rAF loop and rely on observers/listeners (avoids a permanent rAF spin).
    const tick = (now: number) => {
      measure();
      if (!cancelled && now < followUntil) {
        rafId = requestAnimationFrame(tick);
      }
    };

    const prefersReduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const r = el.getBoundingClientRect();
    const fullyVisible = r.top >= 0 && r.bottom <= window.innerHeight;
    if (!fullyVisible) {
      el.scrollIntoView({ behavior: prefersReduced ? 'auto' : 'smooth', block: 'center' });
    }

    followUntil = performance.now() + 650; // cover the smooth-scroll animation
    rafId = requestAnimationFrame(tick);

    const onViewportChange = () => {
      setInsets(readSafeInsets());
      measure();
    };
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('orientationchange', onViewportChange);
    window.addEventListener('scroll', measure, { passive: true, capture: true });

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure);
      ro.observe(el);
      ro.observe(document.body);
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('orientationchange', onViewportChange);
      window.removeEventListener('scroll', measure, { capture: true } as EventListenerOptions);
      ro?.disconnect();
    };
  }, [anchor, active]);

  return { rect, insets, ready };
}
