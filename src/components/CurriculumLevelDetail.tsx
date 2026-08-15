import { ArrowLeft, CheckCircle2, MapPin, Circle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { CurriculumTreeLevel, CurriculumNodeStatus } from '../lib/curriculumApi';

interface Props {
  level: CurriculumTreeLevel;
  onBack: () => void;
}

// Text labels (never color-only): every state is spelled out in words.
const MODULE_STATE_META: Record<
  CurriculumNodeStatus,
  { label: string; icon: LucideIcon; iconClass: string; badgeClass: string }
> = {
  completed: {
    label: 'Concluído',
    icon: CheckCircle2,
    iconClass: 'text-green-400',
    badgeClass: 'bg-green-900/30 border border-green-800/40 text-green-300',
  },
  current: {
    label: 'Você está aqui',
    icon: MapPin,
    iconClass: 'text-blue-400',
    badgeClass: 'bg-blue-900/30 border border-blue-800/40 text-blue-200',
  },
  future: {
    label: 'Futuro',
    icon: Circle,
    iconClass: 'text-slate-500',
    badgeClass: 'bg-slate-700/50 border border-slate-700 text-slate-400',
  },
};

/**
 * Read-only module list for a single level. Viewing a level (including a future
 * one) NEVER mutates progress — this component takes the already-loaded level
 * data and performs no writes and no level selection.
 */
export default function CurriculumLevelDetail({ level, onBack }: Props) {
  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      <header className="sticky top-0 bg-slate-800 border-b border-slate-700 px-2 py-3 z-10 flex items-center gap-1">
        <button
          onClick={onBack}
          className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
          aria-label="Voltar aos níveis"
        >
          <ArrowLeft className="w-5 h-5 shrink-0" aria-hidden="true" />
        </button>
        <h1 className="text-base font-semibold text-slate-100">
          {level.levelCode} · {level.name}
        </h1>
      </header>

      <div className="flex-1 overflow-auto p-4 max-w-lg mx-auto w-full space-y-4 pb-20">
        <section className="bg-slate-800 rounded-xl p-5 space-y-1">
          <p className="text-xs text-slate-400 uppercase tracking-wider font-medium">{level.band}</p>
          <p className="text-lg font-bold text-slate-100 leading-tight">
            {level.levelCode} — {level.name}
          </p>
          {level.status === 'current' && (
            <span className="inline-block mt-1 px-2 py-0.5 rounded text-[11px] font-semibold tracking-wide bg-blue-900/40 border border-blue-700/50 text-blue-200">
              SEU NÍVEL
            </span>
          )}
          {level.status === 'completed' && (
            <span className="inline-block mt-1 px-2 py-0.5 rounded text-[11px] font-semibold tracking-wide bg-green-900/30 border border-green-800/40 text-green-300">
              Concluído
            </span>
          )}
        </section>

        <div className="space-y-2">
          {level.modules.length === 0 && (
            <p className="text-sm text-slate-500 text-center py-8">
              Os módulos deste nível ainda serão disponibilizados.
            </p>
          )}
          {level.modules.map((mod) => {
            const meta = MODULE_STATE_META[mod.status];
            const Icon = meta.icon;
            return (
              <div
                key={mod.moduleKey}
                className={`bg-slate-800 rounded-xl p-4 border ${
                  mod.status === 'current' ? 'border-blue-800/60' : 'border-slate-700'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <Icon
                      className={`w-5 h-5 shrink-0 mt-0.5 ${meta.iconClass}`}
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                    <p className="text-sm font-medium text-slate-100 leading-snug min-w-0">{mod.title}</p>
                  </div>
                  <span className={`px-2 py-0.5 rounded text-xs font-medium shrink-0 ${meta.badgeClass}`}>
                    {meta.label}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
