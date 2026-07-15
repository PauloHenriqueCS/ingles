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
      className="w-full"
    >
      <p
        className="
          text-base text-slate-100 text-center leading-loose
          bg-slate-900/80 backdrop-blur-sm
          border border-slate-700/60
          rounded-xl px-5 py-4
          min-h-[5rem]
          transition-opacity duration-300
          [@media(prefers-reduced-motion:reduce)]:transition-none
        "
      >
        {display}
      </p>
    </div>
  );
}
