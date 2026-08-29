import { useState, useRef, useEffect, useId } from 'react';

/**
 * Accessible "?" affordance next to a metric name. Tapping/clicking toggles a
 * short explanation popover. Built for mobile-first: NO hover, NO native `title`
 * — it works by tap/click and closes on outside tap, a second tap on the "?", or
 * Escape (desktop). The "?" is a real button with an aria-label; the popover is a
 * labelled dialog referenced via aria-controls/aria-expanded.
 */
interface Props {
  /** Metric name, e.g. "Precisão" — shown as the popover heading. */
  title: string;
  /** Plain-language explanation. */
  description: string;
  /** Accessible label for the button, e.g. "Entender Precisão". */
  buttonLabel: string;
  /** Accessible label for the popover region, e.g. "Explicação da métrica". */
  regionLabel: string;
}

export default function MetricInfoTip({ title, description, buttonLabel, regionLabel }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const popoverId = useId();

  useEffect(() => {
    if (!open) return;
    // Close on a tap/click anywhere outside this control (capture so it fires
    // before other handlers). pointerdown covers both touch and mouse.
    const onPointerDown = (e: PointerEvent | MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <span ref={wrapRef} className="relative inline-flex align-middle">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={buttonLabel}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? popoverId : undefined}
        // ~28px touch target via padding, ~18px visible circle — comfortable to
        // tap without changing the row height. touch-manipulation kills the 300ms
        // tap delay on mobile.
        className="ml-1 -my-1.5 p-1.5 inline-flex items-center justify-center text-slate-400 hover:text-slate-200 focus:outline-none focus-visible:text-slate-200 touch-manipulation"
      >
        <span
          aria-hidden="true"
          className={`flex items-center justify-center w-[18px] h-[18px] rounded-full border text-[11px] font-bold leading-none transition-colors ${
            open ? 'border-blue-400 text-blue-300' : 'border-slate-600'
          }`}
        >
          ?
        </span>
      </button>

      {open && (
        <div
          id={popoverId}
          role="dialog"
          aria-label={regionLabel}
          className="absolute z-30 left-0 top-8 w-60 max-w-[calc(100vw-2.5rem)] rounded-xl border border-slate-700 bg-slate-900 shadow-xl shadow-black/40 p-3 text-left"
        >
          <p className="text-sm font-semibold text-slate-100 mb-1">{title}</p>
          <p className="text-xs text-slate-300 leading-relaxed">{description}</p>
        </div>
      )}
    </span>
  );
}
