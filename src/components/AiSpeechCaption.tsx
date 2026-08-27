import { useRef, useEffect } from 'react';
import { getDisplayCaption } from '../lib/captionUtils';

interface AiSpeechCaptionProps {
  text: string;
  visible: boolean;
}

export default function AiSpeechCaption({ text, visible }: AiSpeechCaptionProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const display = getDisplayCaption(text);

  // Follow the caption as it grows: keep the newest line in view by scrolling a
  // bottom anchor into view on every update. `block: 'nearest'` only scrolls when
  // the anchor is actually out of view (so it doesn't jitter when the caption
  // already fits), and its scroll-margin-bottom keeps the current line clear of
  // the fixed "Encerrar conversa" bar. This makes the page auto-scroll down to
  // track the speech, and also re-centers on each new reply.
  useEffect(() => {
    if (display) {
      anchorRef.current?.scrollIntoView({ behavior: 'auto', block: 'nearest' });
    }
  }, [display]);

  if (!visible) return null;

  // The caption area reserves a min-height during a call so the layout doesn't
  // collapse/jump between replies. The styled box grows to fit its text (no
  // internal scroll — the page scrolls).
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
      {/* Bottom scroll anchor — its margin keeps the latest line above the fixed CTA. */}
      <div
        ref={anchorRef}
        aria-hidden="true"
        style={{ scrollMarginBottom: 'calc(6rem + env(safe-area-inset-bottom))' }}
      />
    </div>
  );
}
