import { getDisplayCaption } from '../lib/captionUtils';

interface AiSpeechCaptionProps {
  text: string;
  visible: boolean;
}

export default function AiSpeechCaption({ text, visible }: AiSpeechCaptionProps) {
  const display = getDisplayCaption(text);

  if (!visible || !display) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      aria-label="Legenda da conversa"
      className="w-full max-w-sm mx-auto"
    >
      <p
        className="
          text-sm text-slate-200 text-center leading-relaxed
          bg-slate-900/80 backdrop-blur-sm
          border border-slate-700/60
          rounded-xl px-4 py-2.5
          transition-opacity duration-300
          [@media(prefers-reduced-motion:reduce)]:transition-none
        "
      >
        {display}
      </p>
    </div>
  );
}
