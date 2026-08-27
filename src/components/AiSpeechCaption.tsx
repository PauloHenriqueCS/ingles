import { useRef, useEffect } from 'react';
import { getDisplayCaption } from '../lib/captionUtils';

interface AiSpeechCaptionProps {
  text: string;
  visible: boolean;
}

export default function AiSpeechCaption({ text, visible }: AiSpeechCaptionProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const display = getDisplayCaption(text);

  // Keep the newest (currently-spoken) line visible by pinning the scroll to the
  // bottom as text streams in. Older lines stay scrollable above, so a long
  // reply is fully readable without the current position ever going off-screen.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [display]);

  if (!visible || !display) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      aria-label="Legenda da conversa"
      className="w-full"
    >
      <div
        ref={scrollRef}
        className="
          max-h-40 overflow-y-auto
          bg-slate-900/80 backdrop-blur-sm
          border border-slate-700/60
          rounded-xl px-5 py-4
        "
      >
        <p
          className="
            text-base text-slate-100 text-center leading-relaxed
            whitespace-pre-wrap
            [@media(prefers-reduced-motion:reduce)]:transition-none
          "
        >
          {display}
        </p>
      </div>
    </div>
  );
}
