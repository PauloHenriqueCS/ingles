import { useState, useEffect, useMemo } from 'react';
import { Settings } from 'lucide-react';
import { EntriesStore, DailyProgress } from '../types';
import { getAllDatesInMonth, MONTH_NAMES_PT } from '../data/calendar2026';
import { saveLearningSettings, LearningSettings } from '../lib/learningSettings';
import { getMonthSessionTotals, getConversationGoalMinutes } from '../lib/conversationSessions';
import { getPronunciationDatesForMonth, computeDailyProgress } from '../lib/dailyProgress';
import { getListeningDatesForMonth } from '../services/listening/calendar/get-listening-calendar-activities';
import DailyProgressIcons from './DailyProgressIcons';
import DailyProgressModal from './DailyProgressModal';

interface Props {
  entries: EntriesStore;
  currentMonth: number;
  currentYear: number;
  onChangeMonth: (month: number, year: number) => void;
  onOpenDay: (date: string) => void;
  onOpenListening?: () => void;
  activeWeekdays?: number[];
  overrideDates?: string[];
  onSettingsChange?: (settings: LearningSettings) => void;
}

const DOW_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export default function MonthView({
  entries, currentMonth, currentYear, onChangeMonth, onOpenDay, onOpenListening: _onOpenListening,
  activeWeekdays = [1, 2, 3, 4, 5], overrideDates = [], onSettingsChange,
}: Props) {
  const today = (() => {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    } catch {
      return new Date().toISOString().split('T')[0];
    }
  })();
  const dates = getAllDatesInMonth(currentYear, currentMonth);
  const firstDow = new Date(dates[0] + 'T12:00:00').getDay();
  const blanks = Array(firstDow).fill(null);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedDays, setSelectedDays] = useState<number[]>(activeWeekdays);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [convTotals, setConvTotals] = useState<Record<string, number>>({});
  const [convGoalSec, setConvGoalSec] = useState<number>(15 * 60);
  const [pronunciationDates, setPronunciationDates] = useState<Set<string>>(new Set());
  const [listeningProgress, setListeningProgress] = useState<Record<string, 'not_started' | 'in_progress' | 'completed'>>({});
  const [modalDate, setModalDate] = useState<string | null>(null);

  useEffect(() => { setSelectedDays(activeWeekdays); }, [activeWeekdays.join(',')]);

  useEffect(() => {
    getMonthSessionTotals(currentYear, currentMonth).then(setConvTotals).catch(() => {});
    getPronunciationDatesForMonth(currentYear, currentMonth)
      .then(setPronunciationDates)
      .catch(() => {});
    getListeningDatesForMonth(currentYear, currentMonth).then(setListeningProgress).catch(() => {});
  }, [currentYear, currentMonth]);

  useEffect(() => {
    getConversationGoalMinutes().then((min) => setConvGoalSec(min * 60)).catch(() => {});
  }, []);

  const dailyProgressMap = useMemo<Record<string, DailyProgress>>(() => {
    const allDates = getAllDatesInMonth(currentYear, currentMonth);
    const map: Record<string, DailyProgress> = {};
    for (const d of allDates) {
      map[d] = computeDailyProgress(
        d,
        entries[d],
        convTotals[d] ?? 0,
        convGoalSec,
        pronunciationDates,
        listeningProgress[d],
      );
    }
    return map;
  }, [currentYear, currentMonth, entries, convTotals, convGoalSec, pronunciationDates, listeningProgress]);

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
    <>
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
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm bg-green-700" />
            <span className="text-xs text-slate-400">Todas concluídas</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-violet-400" />
            <span className="text-xs text-slate-400">Escrita</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-blue-400" />
            <span className="text-xs text-slate-400">Pronúncia</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-teal-400" />
            <span className="text-xs text-slate-400">Conversa</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            <span className="text-xs text-slate-400">Listening</span>
          </div>
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
            const isToday = dateStr === today;
            const progress = dailyProgressMap[dateStr];

            return (
              <button
                key={dateStr}
                onClick={() => setModalDate(dateStr)}
                className={`
                  aspect-square rounded-md flex flex-col items-center justify-center text-xs font-medium transition-all cursor-pointer
                  ${isInactive ? 'opacity-40' : 'hover:ring-1 hover:ring-blue-400'}
                  ${isToday ? 'ring-2 ring-blue-400' : ''}
                  ${progress?.allActiveCompleted ? 'bg-green-700' : isInactive ? 'bg-slate-800' : 'bg-slate-700'}
                `}
              >
                <span className={isToday ? 'text-white font-bold' : 'text-slate-300'}>
                  {date.getDate()}
                </span>
                {progress && <DailyProgressIcons progress={progress} />}
              </button>
            );
          })}
        </div>

        {/* Month summary */}
        <div className="mt-4 bg-slate-800 rounded-lg p-3">
          {(() => {
            const activeDates = dates.filter((d) => {
              const dow = new Date(d + 'T12:00:00').getDay();
              return activeWeekdays.includes(dow) || overrideDates.includes(d);
            });
            const total = activeDates.length;
            const writingDone = activeDates.filter(
              (d) => dailyProgressMap[d]?.writing === 'completed',
            ).length;
            const convDone = activeDates.filter(
              (d) => dailyProgressMap[d]?.conversation === 'completed',
            ).length;
            const pronDone = activeDates.filter(
              (d) => dailyProgressMap[d]?.pronunciation === 'completed',
            ).length;
            return (
              <div className="flex gap-4 text-sm flex-wrap">
                <span className="text-slate-400">
                  Escrita: <span className="text-slate-200 font-medium">{writingDone}/{total}</span>
                </span>
                <span className="text-slate-400">
                  Conversa: <span className="text-teal-400 font-medium">{convDone}/{total}</span>
                </span>
                <span className="text-slate-400">
                  Pronúncia: <span className="text-blue-400 font-medium">{pronDone}/{total}</span>
                </span>
              </div>
            );
          })()}
        </div>

        {/* Practice days config */}
        <div className="mt-4">
          <button
            onClick={() => setSettingsOpen((o) => !o)}
            className="w-full flex items-center justify-between px-3 py-2.5 bg-slate-800 rounded-xl text-xs text-slate-400 hover:text-slate-200 transition-colors"
          >
            <span className="flex items-center gap-1.5">
              <Settings className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
              Dias de prática
            </span>
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

      {modalDate && (
        <DailyProgressModal
          date={modalDate}
          progress={dailyProgressMap[modalDate]}
          convTotalSec={convTotals[modalDate] ?? 0}
          convGoalSec={convGoalSec}
          onOpenDay={onOpenDay}
          onClose={() => setModalDate(null)}
        />
      )}
    </>
  );
}
