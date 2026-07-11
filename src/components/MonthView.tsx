import { useState, useEffect } from 'react';
import { EntriesStore, Status } from '../types';
import { getAllDatesInMonth, MONTH_NAMES_PT } from '../data/calendar2026';
import { saveLearningSettings, LearningSettings } from '../lib/learningSettings';

interface Props {
  entries: EntriesStore;
  currentMonth: number;
  currentYear: number;
  onChangeMonth: (month: number, year: number) => void;
  onOpenDay: (date: string) => void;
  activeWeekdays?: number[];
  overrideDates?: string[];
  onSettingsChange?: (settings: LearningSettings) => void;
}

const STATUS_COLORS: Record<Status, string> = {
  'nao-iniciado': 'bg-slate-700',
  'escrito': 'bg-blue-600',
  'corrigido': 'bg-amber-600',
  'revisado': 'bg-green-600',
};

const DOW_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export default function MonthView({
  entries, currentMonth, currentYear, onChangeMonth, onOpenDay,
  activeWeekdays = [1,2,3,4,5], overrideDates = [], onSettingsChange,
}: Props) {
  const today = new Date().toISOString().split('T')[0];
  const dates = getAllDatesInMonth(currentYear, currentMonth);
  const firstDow = new Date(dates[0] + 'T12:00:00').getDay();
  const blanks = Array(firstDow).fill(null);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedDays, setSelectedDays] = useState<number[]>(activeWeekdays);
  const [saveState, setSaveState] = useState<SaveState>('idle');

  useEffect(() => { setSelectedDays(activeWeekdays); }, [activeWeekdays.join(',')]);

  function toggleDay(dow: number) {
    setSelectedDays((prev) => {
      if (prev.includes(dow)) {
        if (prev.length <= 1) return prev;
        return prev.filter((d) => d !== dow);
      }
      return [...prev, dow].sort((a, b) => a - b);
    });
  }

  async function saveSettings() {
    setSaveState('saving');
    try {
      const settings: LearningSettings = { activeWeekdays: selectedDays };
      await saveLearningSettings(settings);
      onSettingsChange?.(settings);
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 2500);
    } catch {
      setSaveState('error');
      setTimeout(() => setSaveState('idle'), 3000);
    }
  }

  function prev() {
    if (currentMonth === 1) onChangeMonth(12, currentYear - 1);
    else onChangeMonth(currentMonth - 1, currentYear);
  }
  function next() {
    if (currentMonth === 12) onChangeMonth(1, currentYear + 1);
    else onChangeMonth(currentMonth + 1, currentYear);
  }

  return (
    <div className="p-4 max-w-lg mx-auto">
      <div className="flex items-center justify-between mb-4">
        <button onClick={prev} className="text-slate-400 p-2 hover:text-slate-100">‹</button>
        <h2 className="font-semibold text-slate-100">
          {MONTH_NAMES_PT[currentMonth - 1]} {currentYear}
        </h2>
        <button onClick={next} className="text-slate-400 p-2 hover:text-slate-100">›</button>
      </div>

      {/* Legend */}
      <div className="flex gap-3 mb-4 flex-wrap">
        {(['nao-iniciado', 'escrito', 'corrigido', 'revisado'] as Status[]).map((s) => (
          <div key={s} className="flex items-center gap-1.5">
            <div className={`w-3 h-3 rounded-sm ${STATUS_COLORS[s]}`} />
            <span className="text-xs text-slate-400 capitalize">
              {s === 'nao-iniciado' ? 'Não iniciado' : s.charAt(0).toUpperCase() + s.slice(1)}
            </span>
          </div>
        ))}
      </div>

      {/* Day of week headers */}
      <div className="grid grid-cols-7 gap-1 mb-1">
        {DOW_LABELS.map((d) => (
          <div key={d} className="text-center text-xs text-slate-500 py-1">{d}</div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7 gap-1">
        {blanks.map((_, i) => <div key={`b${i}`} />)}
        {dates.map((dateStr) => {
          const date = new Date(dateStr + 'T12:00:00');
          const dow = date.getDay();
          const isInactive = !activeWeekdays.includes(dow) && !overrideDates.includes(dateStr);
          const entry = entries[dateStr];
          const status: Status = entry?.status ?? 'nao-iniciado';
          const isToday = dateStr === today;
          const hasText = entry?.originalText?.trim().length > 0;

          return (
            <button
              key={dateStr}
              onClick={() => onOpenDay(dateStr)}
              className={`
                aspect-square rounded-md flex flex-col items-center justify-center text-xs font-medium transition-all
                ${isInactive ? 'opacity-40 cursor-default' : 'hover:ring-1 hover:ring-blue-400 cursor-pointer'}
                ${isToday ? 'ring-2 ring-blue-400' : ''}
                ${hasText ? STATUS_COLORS[status] : isInactive ? 'bg-slate-800' : 'bg-slate-700'}
              `}
              disabled={isInactive}
            >
              <span className={isToday ? 'text-white font-bold' : 'text-slate-300'}>
                {date.getDate()}
              </span>
              {hasText && <div className="w-1 h-1 rounded-full bg-white/60 mt-0.5" />}
            </button>
          );
        })}
      </div>

      {/* Month summary */}
      {currentYear === 2026 && (
        <div className="mt-4 bg-slate-800 rounded-lg p-3">
          {(() => {
            const monthDates = dates.filter((d) => {
              const dow = new Date(d + 'T12:00:00').getDay();
              return activeWeekdays.includes(dow) || overrideDates.includes(d);
            });
            const written = monthDates.filter((d) => entries[d]?.originalText?.trim().length > 0).length;
            const revised = monthDates.filter((d) => entries[d]?.status === 'revisado').length;
            return (
              <div className="flex gap-4 text-sm">
                <span className="text-slate-400">Escritos: <span className="text-slate-200 font-medium">{written}/{monthDates.length}</span></span>
                <span className="text-slate-400">Revisados: <span className="text-green-400 font-medium">{revised}</span></span>
              </div>
            );
          })()}
        </div>
      )}

      {/* Practice days config */}
      <div className="mt-4">
        <button
          onClick={() => setSettingsOpen((o) => !o)}
          className="w-full flex items-center justify-between px-3 py-2.5 bg-slate-800 rounded-xl text-xs text-slate-400 hover:text-slate-200 transition-colors"
        >
          <span>⚙ Dias de prática</span>
          <span>{settingsOpen ? '▲' : '▼'}</span>
        </button>

        {settingsOpen && (
          <div className="mt-2 bg-slate-800 rounded-xl p-4 space-y-3">
            <p className="text-xs text-slate-500">Dias da semana ativos. Mínimo 1 dia.</p>
            <div className="flex gap-2 flex-wrap">
              {DOW_LABELS.map((label, dow) => {
                const active = selectedDays.includes(dow);
                return (
                  <button
                    key={dow}
                    onClick={() => toggleDay(dow)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
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
            <button
              onClick={saveSettings}
              disabled={saveState === 'saving' || selectedDays.length === 0}
              className={`w-full py-2 rounded-lg text-xs font-medium transition-colors ${
                saveState === 'saved'
                  ? 'bg-green-700 text-white'
                  : saveState === 'error'
                  ? 'bg-red-800 text-white'
                  : 'bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white'
              }`}
            >
              {saveState === 'saving' ? 'Salvando...' : saveState === 'saved' ? '✓ Salvo!' : saveState === 'error' ? 'Erro' : 'Salvar'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
