import { useState, useEffect } from 'react';
import { CalendarDays, ListChecks, Loader2, AlertCircle } from 'lucide-react';
import {
  fetchLearningSettings,
  saveLearningSettings,
  DEFAULT_SETTINGS,
} from '../../lib/learningSettings';
import CurriculumModalityPreferences from '../CurriculumModalityPreferences';
import PracticeDaysPicker from './PracticeDaysPicker';

interface Props {
  /** Called once the user finishes step 2 ("Concluir configuração"). The parent
   *  persists the completion flag and releases the Home. */
  onComplete: () => void;
  /** Lets the parent (App) route the Android hardware-back button here: step 2 →
   *  step 1; on step 1 it is a no-op so the user can NEVER escape to the Home
   *  before completing the mandatory configuration (§3). */
  registerBackHandler?: (fn: () => void) => void;
}

type Step = 1 | 2;
type DaysSave = 'idle' | 'saving' | 'error';

/**
 * MANDATORY first-access configuration of the study routine, shown as a
 * full-screen gate DIRECTLY AFTER the Home tutorial and before the Home is
 * released. Two visual steps in a single flow:
 *   1) Dias de prática  → persisted to user_learning_settings (reuses the exact
 *      Calendar rules via PracticeDaysPicker).
 *   2) Práticas do plano → reuses CurriculumModalityPreferences (same icons,
 *      texts, states, "menu = regra" rule and the Conversação IA warning), which
 *      self-persists each toggle to user_curriculum_preferences.
 *
 * It is NON-DISMISSIBLE by design (§3): no X, no backdrop to tap, and the back
 * button is owned here — there is no way to reach the Home until step 2 is
 * concluded and the completion flag is persisted by the parent.
 */
export default function StudyRoutineOnboarding({ onComplete, registerBackHandler }: Props) {
  const [step, setStep] = useState<Step>(1);
  const [days, setDays] = useState<number[]>(DEFAULT_SETTINGS.activeWeekdays);
  const [daysLoaded, setDaysLoaded] = useState(false);
  const [daysSave, setDaysSave] = useState<DaysSave>('idle');

  // Seed from any existing setting (a returning-but-unconfigured user keeps what
  // they had; a brand-new user gets the Mon–Fri default). Never overwrites here —
  // persistence happens only on "Continuar".
  useEffect(() => {
    let alive = true;
    fetchLearningSettings()
      .then((s) => { if (alive) setDays(s.activeWeekdays); })
      .catch(() => {})
      .finally(() => { if (alive) setDaysLoaded(true); });
    return () => { alive = false; };
  }, []);

  // Own the Android back button while this gate is on screen (§3/§6).
  useEffect(() => {
    registerBackHandler?.(() => {
      // Reads the latest step via the functional updater (no stale closure).
      setStep((s) => (s === 2 ? 1 : 1));
    });
  }, [registerBackHandler]);

  async function handleContinue() {
    if (days.length === 0) return; // guarded by min-1, defensive only
    setDaysSave('saving');
    try {
      await saveLearningSettings({ activeWeekdays: days });
      setDaysSave('idle');
      setStep(2);
    } catch {
      setDaysSave('error');
    }
  }

  return (
    <div className="fixed inset-0 z-[80] bg-slate-900 text-slate-100 flex flex-col">
      {/* Header — brand + step indicator. Safe-area padded (Android edge-to-edge). */}
      <div
        className="shrink-0 px-5 pb-3 border-b border-slate-800"
        style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top))' }}
      >
        <div className="max-w-lg mx-auto w-full flex items-center justify-between gap-3">
          <img
            src="/brand/lemon-logo.png"
            alt="Orodim"
            className="h-7 w-auto object-contain shrink-0"
            width={110}
            height={35}
            draggable={false}
          />
          <span className="text-xs font-medium text-slate-400">Etapa {step} de 2</span>
        </div>
        {/* Progress bar (2 segments) */}
        <div className="max-w-lg mx-auto w-full mt-3 flex gap-1.5">
          <div className={`h-1 flex-1 rounded-full ${step >= 1 ? 'bg-blue-500' : 'bg-slate-700'}`} />
          <div className={`h-1 flex-1 rounded-full ${step >= 2 ? 'bg-blue-500' : 'bg-slate-700'}`} />
        </div>
      </div>

      {/* Scrollable body — never over-tall; scrolls on small screens (§8). */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-lg mx-auto w-full px-5 py-6 space-y-5">
          {step === 1 ? (
            <>
              <div className="space-y-2">
                <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-blue-600/20 text-blue-300">
                  <CalendarDays className="w-6 h-6" strokeWidth={2} aria-hidden="true" />
                </div>
                <h1 className="text-xl font-bold text-slate-100">Escolha seus dias de prática</h1>
                <p className="text-sm text-slate-400 leading-relaxed">
                  Em quais dias você pretende praticar inglês?
                </p>
              </div>

              <div className="bg-slate-800 rounded-xl p-5 space-y-3">
                <p className="text-xs text-slate-500">Dias da semana ativos. Mínimo 1 dia.</p>
                {daysLoaded ? (
                  <PracticeDaysPicker value={days} onChange={setDays} disabled={daysSave === 'saving'} />
                ) : (
                  <div className="flex items-center gap-2 py-2 text-slate-400 text-sm">
                    <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" />
                    Carregando...
                  </div>
                )}
              </div>

              {daysSave === 'error' && (
                <p className="text-xs text-red-400 flex items-center gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  Não foi possível salvar. Tente novamente.
                </p>
              )}
            </>
          ) : (
            <>
              <div className="space-y-2">
                <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-blue-600/20 text-blue-300">
                  <ListChecks className="w-6 h-6" strokeWidth={2} aria-hidden="true" />
                </div>
                <h1 className="text-xl font-bold text-slate-100">Escolha suas práticas</h1>
                <p className="text-sm text-slate-400 leading-relaxed">
                  Escolha quais práticas farão parte do seu plano de ensino.
                </p>
              </div>

              {/* Reused as-is: icons, labels, states, "menu = regra" rule and the
                  Conversação IA warning. Each toggle self-persists to the same
                  user_curriculum_preferences source of truth. */}
              <CurriculumModalityPreferences />
            </>
          )}
        </div>
      </div>

      {/* Footer CTA — clear, fixed at the bottom, safe-area padded (§8). */}
      <div
        className="shrink-0 border-t border-slate-800 bg-slate-900/95 px-5 pt-3"
        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
      >
        <div className="max-w-lg mx-auto w-full">
          {step === 1 ? (
            <button
              onClick={handleContinue}
              disabled={!daysLoaded || days.length === 0 || daysSave === 'saving'}
              className="w-full py-3 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors flex items-center justify-center gap-2"
            >
              {daysSave === 'saving' && <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" />}
              {daysSave === 'saving' ? 'Salvando...' : 'Continuar'}
            </button>
          ) : (
            <div className="flex items-center gap-3">
              <button
                onClick={() => setStep(1)}
                className="px-4 py-3 rounded-xl text-sm font-medium text-slate-300 hover:bg-slate-800 transition-colors shrink-0"
              >
                Voltar
              </button>
              <button
                onClick={onComplete}
                className="flex-1 py-3 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors"
              >
                Concluir configuração
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
