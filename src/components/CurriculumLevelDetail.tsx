import { ArrowLeft, CheckCircle2, MapPin, Circle, ChevronRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { CurriculumTreeLevel, CurriculumNodeStatus } from '../lib/curriculumApi';
import { curriculumUiStrings } from '../i18n/curriculumUiStrings';

interface Props {
  level: CurriculumTreeLevel;
  interfaceLanguage: string | null;
  onBack: () => void;
  /** Opens the read-only step detail for a module (pure navigation, no write). */
  onSelectModule: (moduleKey: string) => void;
}

// Progress-bar fill colour per module state (paired with the text label, never
// color-only — the "X de Y etapas" text and the status badge carry the meaning).
const MODULE_BAR_CLASS: Record<CurriculumNodeStatus, string> = {
  completed: 'bg-green-500',
  current: 'bg-blue-500',
  future: 'bg-slate-600',
};

// Icon/colour per module state; the LABEL is interface-language localized at
// render (never color-only, never a hardcoded pt-BR string).
const MODULE_STATE_META: Record<
  CurriculumNodeStatus,
  { icon: LucideIcon; iconClass: string; badgeClass: string }
> = {
  completed: { icon: CheckCircle2, iconClass: 'text-green-400', badgeClass: 'bg-green-900/30 border border-green-800/40 text-green-300' },
  current: { icon: MapPin, iconClass: 'text-blue-400', badgeClass: 'bg-blue-900/30 border border-blue-800/40 text-blue-200' },
  future: { icon: Circle, iconClass: 'text-slate-500', badgeClass: 'bg-slate-700/50 border border-slate-700 text-slate-400' },
};

function levelDescriptor(levelCode: string, name: string, band: string): string {
  if (name && name !== levelCode) return name;
  return band || levelCode;
}

/**
 * Read-only module list for a single level. Viewing a level (including a future
 * one) NEVER mutates progress — this component takes the already-loaded level
 * data and performs no writes and no level selection.
 */
export default function CurriculumLevelDetail({ level, interfaceLanguage, onBack, onSelectModule }: Props) {
  const t = curriculumUiStrings(interfaceLanguage);
  const descriptor = levelDescriptor(level.levelCode, level.name, level.band);
  const showBand = level.band && level.band !== descriptor;
  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      <header className="sticky top-0 bg-slate-800 border-b border-slate-700 px-2 py-3 z-10 flex items-center gap-1">
        <button
          onClick={onBack}
          className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
          aria-label={t.backToLevels}
        >
          <ArrowLeft className="w-5 h-5 shrink-0" aria-hidden="true" />
        </button>
        <h1 className="text-base font-semibold text-slate-100">
          {level.levelCode} · {descriptor}
        </h1>
      </header>

      <div className="flex-1 overflow-auto p-4 max-w-lg mx-auto w-full space-y-4 pb-20">
        <section className="bg-slate-800 rounded-xl p-5 space-y-1">
          {showBand && <p className="text-xs text-slate-400 uppercase tracking-wider font-medium">{level.band}</p>}
          <p className="text-lg font-bold text-slate-100 leading-tight">
            {level.levelCode} — {descriptor}
          </p>
          {level.status === 'current' && (
            <span className="inline-block mt-1 px-2 py-0.5 rounded text-[11px] font-semibold tracking-wide bg-blue-900/40 border border-blue-700/50 text-blue-200">
              {t.statusYourLevel}
            </span>
          )}
          {level.status === 'completed' && (
            <span className="inline-block mt-1 px-2 py-0.5 rounded text-[11px] font-semibold tracking-wide bg-green-900/30 border border-green-800/40 text-green-300">
              {t.statusCompleted}
            </span>
          )}
        </section>

        <div className="space-y-2">
          {level.modules.length === 0 && (
            <p className="text-sm text-slate-500 text-center py-8">{t.modulesComingSoon}</p>
          )}
          {level.modules.map((mod) => {
            const meta = MODULE_STATE_META[mod.status];
            const Icon = meta.icon;
            const modLabel = mod.status === 'current' ? t.statusYouAreHere : mod.status === 'completed' ? t.statusCompleted : t.statusFuture;
            const pct = mod.totalSteps > 0 ? Math.round((mod.completedSteps / mod.totalSteps) * 100) : 0;
            return (
              <button
                key={mod.moduleKey}
                type="button"
                onClick={() => onSelectModule(mod.moduleKey)}
                className={`w-full text-left bg-slate-800 rounded-xl p-4 border transition-colors hover:bg-slate-700/50 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                  mod.status === 'current' ? 'border-blue-800/60' : 'border-slate-700'
                }`}
                aria-label={`${mod.title} — ${t.stepsProgress(mod.completedSteps, mod.totalSteps)} (${modLabel})`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <Icon
                      className={`w-5 h-5 shrink-0 mt-0.5 ${meta.iconClass}`}
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-100 leading-snug min-w-0">{mod.title}</p>
                      {mod.totalSteps > 0 && (
                        <p className="text-xs text-slate-400 mt-0.5">{t.stepsProgress(mod.completedSteps, mod.totalSteps)}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${meta.badgeClass}`}>
                      {modLabel}
                    </span>
                    <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" aria-hidden="true" />
                  </div>
                </div>
                {mod.totalSteps > 0 && (
                  <div className="mt-3 h-1.5 rounded-full bg-slate-700/70 overflow-hidden" aria-hidden="true">
                    <div className={`h-full rounded-full ${MODULE_BAR_CLASS[mod.status]}`} style={{ width: `${pct}%` }} />
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
