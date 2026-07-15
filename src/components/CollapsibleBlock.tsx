import { useState } from 'react';

interface Props {
  title: string;
  badge?: string;
  defaultOpen?: boolean;
  /** Extra content rendered right of the badge, left of the arrow */
  headerRight?: React.ReactNode;
  children: React.ReactNode;
  /** Extra classes on the wrapper div */
  className?: string;
}

export default function CollapsibleBlock({
  title,
  badge,
  defaultOpen = true,
  headerRight,
  children,
  className = '',
}: Props) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={`border border-slate-700 rounded-xl overflow-hidden ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-left bg-slate-800 transition-colors"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm text-slate-300 font-medium truncate">{title}</span>
          {badge && <span className="text-xs text-slate-500 shrink-0">{badge}</span>}
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-2">
          {headerRight}
          <span className="text-slate-500 text-xs" aria-hidden="true">{open ? '▲' : '▼'}</span>
        </div>
      </button>
      {/* CSS grid trick for smooth height animation */}
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-in-out"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <div className="bg-slate-800/60 px-4 pb-4 pt-2">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
