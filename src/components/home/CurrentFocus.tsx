import { Target } from 'lucide-react';
import type { CurriculumProgress } from '../../lib/curriculumApi';
import { curriculumUiStrings } from '../../i18n/curriculumUiStrings';

interface Props {
  data: CurriculumProgress | null;
  loading: boolean;
  error: boolean;
}

function isCompletedStatus(status: CurriculumProgress['status']): boolean {
  return status === 'curriculum_completed' || status === 'completed';
}

/**
 * "Foco atual" — the CURRENT curriculum recorte shown as read-only CONTEXT, not
 * a navigation target. Deliberately NON-interactive: no button, no chevron, no
 * hover/press affordance, lower contrast and more compact than the activity
 * cards, so it reads as status rather than something to tap. Data is passed in
 * (fetched once at the Home level) — this component never fetches.
 *
 * Renders nothing on loading/error/absence: never fabricate a recorte.
 */
export default function CurrentFocus({ data, loading, error }: Props) {
  if (loading || error || !data) return null;

  const t = curriculumUiStrings(data.interfaceLanguage);
  const completed = isCompletedStatus(data.status);
  const focus = data.currentFocus?.trim() || null;

  const primary = focus ? focus : completed ? t.focusCompleted : t.focusInitializing;
  const compact = focus ? [data.currentLevel, data.currentModuleTitle].filter(Boolean).join(' · ') : '';

  return (
    // Non-interactive on purpose. Discreet surface (dimmer than activity cards),
    // no ring/hover, compact padding, a faint target watermark for texture.
    <div className="relative overflow-hidden rounded-xl border border-slate-800 bg-slate-800/30 px-4 py-3">
      <Target
        className="pointer-events-none absolute -right-3 -bottom-3 w-20 h-20 text-slate-700/20"
        strokeWidth={1.5}
        aria-hidden="true"
      />
      <div className="relative flex items-center gap-3">
        <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-blue-500/15 border border-blue-500/20 shrink-0">
          <Target className="w-4 h-4 text-blue-300" strokeWidth={2} aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-blue-300/80">
            {t.focusEyebrow}
          </p>
          <p className="text-sm font-semibold text-slate-200 leading-snug break-words">{primary}</p>
          {compact && <p className="text-xs text-slate-500 mt-0.5 break-words">{compact}</p>}
        </div>
      </div>
    </div>
  );
}
