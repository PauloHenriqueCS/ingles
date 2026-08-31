import { useState, useEffect } from 'react';
import { CalendarDays, Check, Loader2, AlertCircle } from 'lucide-react';
import {
  fetchLearningSettings,
  saveLearningSettings,
  DEFAULT_SETTINGS,
  type LearningSettings,
} from '../../lib/learningSettings';
import ScreenHeader from '../ScreenHeader';
import CurriculumModalityPreferences from '../CurriculumModalityPreferences';
import PracticeDaysPicker from './PracticeDaysPicker';

interface Props {
  onBack: () => void;
  /** Lets App refresh its in-memory learningSettings so the calendar/home/streak
   *  reflect a change to the practice days immediately (same source of truth). */
  onSettingsChange?: (settings: LearningSettings) => void;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * "Rotina de estudos" — the menu-accessible, EDITABLE version of the initial
 * configuration. One screen with two sections (practice days + plan practices),
 * both writing to the SAME sources of truth used everywhere else
 * (user_learning_settings + user_curriculum_preferences). Not a mandatory modal:
 * it has a normal back arrow and never blocks.
 */
export default function StudyRoutineView({ onBack, onSettingsChange }: Props) {
  const [days, setDays] = useState<number[]>(DEFAULT_SETTINGS.activeWeekdays);
  const [daysLoaded, setDaysLoaded] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');

  useEffect(() => {
    let alive = true;
    fetchLearningSettings()
      .then((s) => { if (alive) setDays(s.activeWeekdays); })
      .catch(() => {})
      .finally(() => { if (alive) setDaysLoaded(true); });
    return () => { alive = false; };
  }, []);

  function handleDaysChange(next: number[]) {
    setDays(next);
    if (saveState === 'saved') setSaveState('idle');
  }

  async function saveDays() {
    setSaveState('saving');
    try {
      const settings: LearningSettings = { activeWeekdays: days };
      await saveLearningSettings(settings);
      onSettingsChange?.(settings);
      setSaveState('saved');
      setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 2500);
    } catch {
      setSaveState('error');
      setTimeout(() => setSaveState((s) => (s === 'error' ? 'idle' : s)), 3000);
    }
  }

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      <ScreenHeader onBack={onBack} title="Rotina de estudos" />

      <div className="flex-1 overflow-auto p-4 max-w-lg mx-auto w-full space-y-4 pb-24">
        {/* Section 1 — Dias de prática */}
        <section className="bg-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex items-start gap-3">
            <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-blue-600/20 text-blue-300 shrink-0">
              <CalendarDays className="w-5 h-5" strokeWidth={2} aria-hidden="true" />
            </div>
            <div className="space-y-0.5 min-w-0">
              <h2 className="text-sm font-semibold text-slate-100">Dias de prática</h2>
              <p className="text-xs text-slate-400 leading-relaxed">
                Em quais dias você pretende praticar inglês? Mínimo 1 dia.
              </p>
            </div>
          </div>

          {daysLoaded ? (
            <PracticeDaysPicker value={days} onChange={handleDaysChange} disabled={saveState === 'saving'} />
          ) : (
            <div className="flex items-center gap-2 py-2 text-slate-400 text-sm">
              <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" />
              Carregando...
            </div>
          )}

          <div className="flex items-center gap-3">
            <button
              onClick={saveDays}
              disabled={!daysLoaded || days.length === 0 || saveState === 'saving'}
              className="px-5 py-2.5 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
            >
              {saveState === 'saving' && <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" />}
              {saveState === 'saving' ? 'Salvando...' : 'Salvar dias'}
            </button>
            {saveState === 'saved' && (
              <span className="text-xs text-green-400 flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                Salvo!
              </span>
            )}
            {saveState === 'error' && (
              <span className="text-xs text-red-400 flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                Erro ao salvar
              </span>
            )}
          </div>
        </section>

        {/* Section 2 — Práticas do plano (reused, self-persisting). */}
        <CurriculumModalityPreferences />
      </div>
    </div>
  );
}
