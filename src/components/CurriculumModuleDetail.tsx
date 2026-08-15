import { ArrowLeft, CheckCircle2, MapPin, Circle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { CurriculumTreeLevel, CurriculumTreeModule, CurriculumNodeStatus } from '../lib/curriculumApi';
import { curriculumUiStrings } from '../i18n/curriculumUiStrings';

interface Props {
  level: CurriculumTreeLevel;
  module: CurriculumTreeModule;
  interfaceLanguage: string | null;
  onBack: () => void;
}

// Icon/colour per step (etapa) state; the LABEL is interface-language localized
// at render (never color-only, never a hardcoded pt-BR string).
const STEP_STATE_META: Record<
  CurriculumNodeStatus,
  { icon: LucideIcon; iconClass: string; badgeClass: string }
> = {
  completed: { icon: CheckCircle2, iconClass: 'text-green-400', badgeClass: 'bg-green-900/30 border border-green-800/40 text-green-300' },
  current: { icon: MapPin, iconClass: 'text-blue-400', badgeClass: 'bg-blue-900/40 border border-blue-700/50 text-blue-200 font-semibold' },
  future: { icon: Circle, iconClass: 'text-slate-500', badgeClass: 'bg-slate-700/50 border border-slate-700 text-slate-400' },
};

function levelDescriptor(levelCode: string, name: string, band: string): string {
  if (name && name !== levelCode) return name;
  return band || levelCode;
}

/**
 * Read-only STEP (etapa) list for a single module. This is pure navigation into
 * a detail view — it performs NO writes, exposes NO internal semantic keys, and a
 * future step is only viewable, never a progression selector: tapping a step
 * does nothing. Progression stays 100% server-authoritative; this screen only
 * mirrors the completed/current/future status the tree endpoint already derived.
 */
export default function CurriculumModuleDetail({ level, module, interfaceLanguage, onBack }: Props) {
  const t = curriculumUiStrings(interfaceLanguage);
  const descriptor = levelDescriptor(level.levelCode, level.name, level.band);

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      <header className="sticky top-0 bg-slate-800 border-b border-slate-700 px-2 py-3 z-10 flex items-center gap-1">
        <button
          onClick={onBack}
          className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
          aria-label={t.backToModules}
        >
          <ArrowLeft className="w-5 h-5 shrink-0" aria-hidden="true" />
        </button>
        <h1 className="text-base font-semibold text-slate-100 leading-tight min-w-0 truncate">{module.title}</h1>
      </header>

      <div className="flex-1 overflow-auto p-4 max-w-lg mx-auto w-full space-y-4 pb-20">
        <section className="bg-slate-800 rounded-xl p-5 space-y-1">
          <p className="text-xs text-slate-400 uppercase tracking-wider font-medium">
            {level.levelCode} · {descriptor}
          </p>
          <p className="text-lg font-bold text-slate-100 leading-tight">{module.title}</p>
          {module.totalSteps > 0 && (
            <p className="text-sm text-slate-300 mt-1">
              {t.stepsCompletedCount(module.completedSteps, module.totalSteps)}
            </p>
          )}
        </section>

        <section className="space-y-2">
          <p className="text-xs text-slate-500 uppercase tracking-wider font-medium px-1">{t.stepsLabel}</p>
          {module.steps.length === 0 && (
            <p className="text-sm text-slate-500 text-center py-8">{t.modulesComingSoon}</p>
          )}
          {module.steps.map((step) => {
            const meta = STEP_STATE_META[step.status];
            const Icon = meta.icon;
            const label = step.status === 'current' ? t.stepCurrent : step.status === 'completed' ? t.stepCompleted : t.stepFuture;
            return (
              <div
                key={step.id}
                className={`bg-slate-800 rounded-xl p-3.5 border ${
                  step.status === 'current' ? 'border-blue-800/60' : 'border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <Icon className={`w-5 h-5 shrink-0 ${meta.iconClass}`} strokeWidth={2} aria-hidden="true" />
                    <p className="text-sm text-slate-100 leading-snug min-w-0">{step.title}</p>
                  </div>
                  <span className={`px-2 py-0.5 rounded text-xs font-medium shrink-0 ${meta.badgeClass}`}>
                    {label}
                  </span>
                </div>
              </div>
            );
          })}
        </section>
      </div>
    </div>
  );
}
