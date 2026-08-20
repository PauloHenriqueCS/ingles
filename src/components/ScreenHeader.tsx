import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';

interface Props {
  /** Navigate back within the app's view-state (never window.history). */
  onBack: () => void;
  /** Optional screen title (truncates on small screens). */
  title?: string;
  /** Optional secondary line under the title. */
  subtitle?: string;
  /** Optional small trailing content (e.g. a progress counter) shown before the logo. */
  right?: ReactNode;
  backLabel?: string;
}

/**
 * The single shared header for every internal (non-home) screen: a back arrow
 * (left) + optional title, and the Orodim logo (right). Same height (h-14),
 * same chrome (bg-slate-900 / border-b) and the same safe-area handling as
 * AppHeader, so every internal screen has one consistent, notch-safe bar
 * instead of the previous mix of bespoke bars (or none, on Escrita). Sticky so
 * it stays put while the screen body scrolls. The back button drives the
 * caller's view-state handler — never the WebView history — so it can never
 * navigate outside the app.
 */
export default function ScreenHeader({ onBack, title, subtitle, right, backLabel = 'Voltar' }: Props) {
  return (
    <header
      className="sticky top-0 left-0 right-0 bg-slate-900 border-b border-slate-800 z-20"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <div className="h-14 flex items-center gap-2 px-4">
        <button
          onClick={onBack}
          aria-label={backLabel}
          className="w-10 h-10 -ml-2 flex items-center justify-center rounded-lg hover:bg-slate-800 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 shrink-0"
        >
          <ArrowLeft className="w-5 h-5 text-slate-300" strokeWidth={2} aria-hidden="true" />
        </button>

        {title || subtitle ? (
          <div className="min-w-0 flex-1">
            {title && <p className="text-sm font-semibold text-slate-100 truncate">{title}</p>}
            {subtitle && <p className="text-xs text-slate-400 truncate leading-tight">{subtitle}</p>}
          </div>
        ) : (
          <div className="flex-1" />
        )}

        {right && <div className="shrink-0">{right}</div>}

        <img
          src="/brand/lemon-logo.png"
          alt="Orodim"
          className="h-8 w-auto object-contain shrink-0"
          width={125}
          height={40}
          draggable={false}
        />
      </div>
    </header>
  );
}
