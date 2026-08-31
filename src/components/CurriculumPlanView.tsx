import { useState, useEffect } from 'react';
import { ArrowLeft, ChevronRight, CheckCircle2, MapPin, Circle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  getCurriculumTree,
  type CurriculumTree,
  type CurriculumTreeLevel,
  type CurriculumTreeModule,
  type CurriculumNodeStatus,
} from '../lib/curriculumApi';
import CurriculumLevelDetail from './CurriculumLevelDetail';
import CurriculumModuleDetail from './CurriculumModuleDetail';
import { curriculumUiStrings } from '../i18n/curriculumUiStrings';

interface Props {
  onBack: () => void;
}

// Icon/colour per level state; the LABEL text is interface-language localized at
// render time (never a hardcoded pt-BR string, never color-only).
const LEVEL_STATE_META: Record<
  CurriculumNodeStatus,
  { icon: LucideIcon; iconClass: string; badgeClass: string }
> = {
  completed: { icon: CheckCircle2, iconClass: 'text-green-400', badgeClass: 'bg-green-900/30 border border-green-800/40 text-green-300' },
  current: { icon: MapPin, iconClass: 'text-blue-400', badgeClass: 'bg-blue-900/40 border border-blue-700/50 text-blue-200 font-semibold tracking-wide' },
  future: { icon: Circle, iconClass: 'text-slate-500', badgeClass: 'bg-slate-700/50 border border-slate-700 text-slate-400' },
};

// Blocker 12: never render "A1 — A1". When the level's display name is just its
// code (a redundant label), fall back to the band as the descriptor so the user
// sees "A1 — Iniciante". A real distinct label (future) is shown as-is.
function levelDescriptor(levelCode: string, name: string, band: string): string {
  if (name && name !== levelCode) return name;
  return band || levelCode;
}

export default function CurriculumPlanView({ onBack }: Props) {
  const [tree, setTree] = useState<CurriculumTree | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'done' | 'error'>('loading');
  const [selectedLevelCode, setSelectedLevelCode] = useState<string | null>(null);
  const [selectedModuleKey, setSelectedModuleKey] = useState<string | null>(null);

  function load() {
    setLoadState('loading');
    getCurriculumTree()
      .then((t) => {
        setTree(t);
        setLoadState('done');
      })
      .catch(() => setLoadState('error'));
  }

  useEffect(() => { load(); }, []);

  // Opening a level (and then a module) is pure navigation into read-only detail
  // views — it never changes the user's level/pointer or writes any progress.
  const selectedLevel: CurriculumTreeLevel | null =
    tree && selectedLevelCode ? tree.levels.find((l) => l.levelCode === selectedLevelCode) ?? null : null;
  // Derived from the CURRENT level's modules only, so backing out of a level
  // clears the module too (no stale cross-level selection).
  const selectedModule: CurriculumTreeModule | null =
    selectedLevel && selectedModuleKey ? selectedLevel.modules.find((m) => m.moduleKey === selectedModuleKey) ?? null : null;

  const t = curriculumUiStrings(tree?.interfaceLanguage);

  if (selectedLevel && selectedModule) {
    return <CurriculumModuleDetail level={selectedLevel} module={selectedModule} interfaceLanguage={tree?.interfaceLanguage ?? null} onBack={() => setSelectedModuleKey(null)} />;
  }

  if (selectedLevel) {
    return <CurriculumLevelDetail level={selectedLevel} interfaceLanguage={tree?.interfaceLanguage ?? null} onBack={() => setSelectedLevelCode(null)} onSelectModule={setSelectedModuleKey} />;
  }

  const isCompleted = tree?.status === 'curriculum_completed';

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      <header className="sticky top-0 bg-slate-800 border-b border-slate-700 px-2 py-3 z-10 flex items-center gap-1">
        <button
          onClick={onBack}
          className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
          aria-label="Voltar"
        >
          <ArrowLeft className="w-5 h-5 shrink-0" aria-hidden="true" />
        </button>
        <h1 className="text-base font-semibold text-slate-100">{t.planTitle}</h1>
      </header>

      <div className="flex-1 overflow-auto p-4 max-w-lg mx-auto w-full space-y-4 pb-20">
        {loadState === 'loading' && (
          <div className="flex flex-col items-center justify-center py-20 space-y-3">
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-slate-400 text-sm">{t.loadingPlan}</p>
          </div>
        )}

        {loadState === 'error' && (
          <div className="bg-red-900/30 border border-red-800 rounded-xl p-6 text-center space-y-3">
            <p className="text-red-300 text-sm">{t.loadError}</p>
            <button onClick={load} className="text-xs text-slate-400 hover:text-slate-200 transition-colors">
              {t.retry}
            </button>
          </div>
        )}

        {loadState === 'done' && tree && (
          <>
            {isCompleted && (
              <section className="bg-green-900/20 border border-green-800/40 rounded-xl p-5 flex items-start gap-3">
                <CheckCircle2 className="w-6 h-6 text-green-400 shrink-0 mt-0.5" strokeWidth={2} aria-hidden="true" />
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-semibold text-green-200">{t.curriculumCompletedTitle}</p>
                  <p className="text-xs text-green-300/80 leading-relaxed">{t.curriculumCompletedBody}</p>
                </div>
              </section>
            )}

            <section className="space-y-1 px-1">
              <p className="text-sm text-slate-300 leading-relaxed">{t.planIntro}</p>
            </section>

            {/* Levels: ALL of A1..C2, each with band + status (text, not color-only) */}
            <div className="space-y-2">
              {tree.levels.map((level) => {
                const meta = LEVEL_STATE_META[level.status];
                const Icon = meta.icon;
                const label = level.status === 'current' ? t.statusYourLevel : level.status === 'completed' ? t.statusCompleted : t.statusFuture;
                const descriptor = levelDescriptor(level.levelCode, level.name, level.band);
                // Only show the band as a secondary line when it isn't already the descriptor.
                const showBand = level.band && level.band !== descriptor;
                return (
                  <button
                    key={level.levelCode}
                    type="button"
                    onClick={() => setSelectedLevelCode(level.levelCode)}
                    className={`w-full text-left bg-slate-800 rounded-xl p-4 border transition-colors hover:bg-slate-700/50 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                      level.status === 'current' ? 'border-blue-800/60' : 'border-slate-700'
                    }`}
                    aria-label={`${level.levelCode} — ${descriptor} (${label})`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <Icon className={`w-5 h-5 shrink-0 ${meta.iconClass}`} strokeWidth={2} aria-hidden="true" />
                        <div className="min-w-0">
                          <p className="text-sm font-bold text-slate-100 leading-tight">
                            {level.levelCode} — {descriptor}
                          </p>
                          {showBand && <p className="text-xs text-slate-500">{level.band}</p>}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={`px-2 py-0.5 rounded text-xs ${meta.badgeClass}`}>
                          {label}
                        </span>
                        <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" aria-hidden="true" />
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
            {/* The practices menu ("Práticas do seu plano") moved out of here to
                the mandatory first-access setup + the menu → "Rotina de estudos"
                (single source of truth: user_curriculum_preferences). */}
          </>
        )}
      </div>
    </div>
  );
}
