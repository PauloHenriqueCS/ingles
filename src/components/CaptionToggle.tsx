import { Captions, CaptionsOff } from 'lucide-react';

interface CaptionToggleProps {
  enabled: boolean;
  onToggle: () => void;
}

export default function CaptionToggle({ enabled, onToggle }: CaptionToggleProps) {
  const label = enabled ? 'Desativar legendas' : 'Ativar legendas';
  const Icon = enabled ? Captions : CaptionsOff;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={enabled}
      aria-label={label}
      title={label}
      className={`
        p-2 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-slate-800
        ${enabled
          ? 'text-blue-400 bg-blue-500/15 hover:bg-blue-500/25'
          : 'text-slate-500 bg-slate-700/50 hover:bg-slate-700 hover:text-slate-300'
        }
      `}
    >
      <Icon className="w-5 h-5" strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}
