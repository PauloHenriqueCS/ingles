import { useRef, useEffect } from 'react';
import { getDisplayCaption } from '../lib/captionUtils';

interface AiSpeechCaptionProps {
  text: string;
  visible: boolean;
}

export default function AiSpeechCaption({ text, visible }: AiSpeechCaptionProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const hadTextRef = useRef(false);
  const display = getDisplayCaption(text);

  // When a NEW reply starts (empty → has text), bring the caption into view so
  // the user never has to scroll the page down again each time. Only on that
  // transition — never on every streamed char — so it doesn't fight the user's
  // own scrolling while reading a long reply.
  useEffect(() => {
    const hasText = display.length > 0;
    if (hasText && !hadTextRef.current) {
      containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    hadTextRef.current = hasText;
  }, [display]);

  if (!visible) return null;

  // The caption AREA is always present during a call (min-height reserved) so the
  // layout doesn't collapse and jump between replies. The styled box only shows
  // when there is text; the box grows to fit it (no internal scroll — the page
  // scrolls if needed).
  return (
    <div
      ref={containerRef}
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
    </div>
  );
}
