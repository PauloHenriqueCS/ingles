import { getDisplayCaption } from '../lib/captionUtils';

interface AiSpeechCaptionProps {
  text: string;
  visible: boolean;
}

export default function AiSpeechCaption({ text, visible }: AiSpeechCaptionProps) {
  const display = getDisplayCaption(text);

  if (!visible || !display) return null;

  // The box grows to fit the full caption — no internal scroll. If a reply is
  // long, the whole screen scrolls (the caption sits in the normal page flow).
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
          text-base text-slate-100 text-center leading-relaxed
          whitespace-pre-wrap
          bg-slate-900/80 backdrop-blur-sm
          border border-slate-700/60
          rounded-xl px-5 py-4
        "
      >
        {display}
      </p>
    </div>
  );
}
