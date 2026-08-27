import { useRef, useEffect } from 'react';
import { getDisplayCaption } from '../lib/captionUtils';

interface AiSpeechCaptionProps {
  text: string;
  visible: boolean;
}

// Approx height (px) reserved at the bottom for the fixed "Encerrar conversa"
// bar + the iOS safe-area, so the current caption line is never scrolled behind it.
const BOTTOM_RESERVE_PX = 120;

/** Nearest actually-scrollable ancestor, or null when the document scrolls. */
function getScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const oy = getComputedStyle(node).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight + 1) return node;
    node = node.parentElement;
  }
  return null;
}

export default function AiSpeechCaption({ text, visible }: AiSpeechCaptionProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const display = getDisplayCaption(text);

  // Follow the caption as it grows: if its bottom edge has dropped below the
  // "target line" (viewport bottom minus the fixed bar), scroll DOWN by exactly
  // that overflow so the current line stays visible just above the bar. We
  // compute and scroll manually (rather than scrollIntoView, which no-ops when
  // the anchor is geometrically on-screen but hidden behind the fixed bar), and
  // only ever scroll down — never yanking the view up.
  useEffect(() => {
    if (!display) return;
    const anchor = anchorRef.current;
    if (!anchor) return;
    const targetBottom = window.innerHeight - BOTTOM_RESERVE_PX;
    const delta = Math.round(anchor.getBoundingClientRect().bottom - targetBottom);
    if (delta > 4) {
      const scroller = getScrollParent(anchor);
      if (scroller) scroller.scrollBy({ top: delta, behavior: 'auto' });
      else window.scrollBy({ top: delta, behavior: 'auto' });
    }
  }, [display]);

  if (!visible) return null;

  // The caption area reserves a min-height during a call so the layout doesn't
  // collapse/jump between replies. The styled box grows to fit its text (no
  // internal scroll — the page scrolls, and we auto-follow above).
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      aria-label="Legenda da conversa"
      className="w-full min-h-[4.5rem]"
    >
      {display && (
        <p
          className="
            text-base text-slate-100 text-center leading-relaxed
            whitespace-pre-wrap
            bg-slate-900/80 backdrop-blur-sm
            border border-slate-700/60
            rounded-xl px-5 py-4
          "
        >
          {display}
        </p>
      )}
      <div ref={anchorRef} aria-hidden="true" />
    </div>
  );
}
