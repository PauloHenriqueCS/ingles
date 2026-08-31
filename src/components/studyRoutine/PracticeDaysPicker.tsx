// Presentational 7-day picker for "Dias de prática". Pure/controlled: the parent
// owns the value and persistence — this component only renders the toggles and
// enforces the SAME rules the Calendar used (weekday domain 0=Dom..6=Sáb, and a
// minimum of 1 active day: the last active day cannot be deselected). Extracted
// so the mandatory onboarding wizard and the "Rotina de estudos" menu screen
// share one identical selector instead of duplicating the markup.

// Same labels/domain as MonthView's DOW_LABELS — index IS the JS getDay() value
// stored in user_learning_settings.active_weekdays (0=Sun … 6=Sat).
export const DOW_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

interface Props {
  /** Currently active weekdays (0=Dom … 6=Sáb). */
  value: number[];
  /** Called with the next set after a toggle. Never emits an empty set (min 1). */
  onChange: (days: number[]) => void;
  disabled?: boolean;
}

export default function PracticeDaysPicker({ value, onChange, disabled }: Props) {
  function toggleDay(dow: number) {
    if (disabled) return;
    if (value.includes(dow)) {
      // Minimum 1 day — refuse to deselect the last active day (same as Calendar).
      if (value.length <= 1) return;
      onChange(value.filter((d) => d !== dow));
    } else {
      onChange([...value, dow].sort((a, b) => a - b));
    }
  }

  return (
    <div className="flex gap-2 flex-wrap">
      {DOW_LABELS.map((label, dow) => {
        const active = value.includes(dow);
        return (
          <button
            key={dow}
            type="button"
            role="switch"
            aria-checked={active}
            aria-label={`${active ? 'Desativar' : 'Ativar'} ${label}`}
            onClick={() => toggleDay(dow)}
            disabled={disabled}
            className={`px-3.5 py-2 rounded-lg text-sm font-medium transition-colors border focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 ${
              active
                ? 'bg-blue-600 border-blue-500 text-white'
                : 'bg-slate-700 border-slate-600 text-slate-400 hover:border-slate-500'
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
