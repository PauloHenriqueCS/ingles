import { useState, useEffect, useMemo } from 'react';
import { Settings, Check, ChevronRight } from 'lucide-react';
import { EntriesStore, DailyProgress } from '../types';
import { getAllDatesInMonth, MONTH_NAMES_PT } from '../data/calendar2026';
import { saveLearningSettings, LearningSettings } from '../lib/learningSettings';
import { getMonthSessionTotals, getConversationGoalMinutes } from '../lib/conversationSessions';
import { getPronunciationDatesForMonth, computeDailyProgress, type ActiveDailyFeatures } from '../lib/dailyProgress';
import { getListeningDatesForMonth } from '../services/listening/calendar/get-listening-calendar-activities';
import { usePlanEntitlements } from '../hooks/usePlanEntitlements';
import { ENTITLEMENT_MESSAGES } from '../domain/entitlements/entitlement-messages';
import DailyProgressIcons from './DailyProgressIcons';
import DailyProgressModal from './DailyProgressModal';

interface Props {
  entries: EntriesStore;
  currentMonth: number;
  currentYear: number;
  onChangeMonth: (month: number, year: number) => void;
  onOpenDay: (date: string) => void;
  onOpenWriting?: () => void;
  onOpenPronunciation?: () => void;
  onOpenConversation?: () => void;
  onOpenListening?: () => void;
  listeningRefreshKey?: number;
  conversationRefreshKey?: number;
  activeWeekdays?: number[];
  overrideDates?: string[];
  onSettingsChange?: (settings: LearningSettings) => void;
}

const DOW_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export default function MonthView({
  entries, currentMonth, currentYear, onChangeMonth, onOpenDay,
  onOpenWriting, onOpenPronunciation, onOpenConversation, onOpenListening,
  listeningRefreshKey = 0, conversationRefreshKey = 0, activeWeekdays = [1, 2, 3, 4, 5], overrideDates = [], onSettingsChange,
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
  const entitlements = usePlanEntitlements();

  // While the plan is still resolving, default to "all three active" —
  // matches computeDailyProgress's own fail-safe default, so the calendar
  // never shows a day as incomplete-for-a-reason-that-doesn't-exist during
  // the loading window, and never flashes green either since the underlying
  // per-activity statuses are unaffected by this flag.
  const activeFeatures: ActiveDailyFeatures = entitlements.data
    ? {
        writingEnabled: entitlements.data.writing.enabled,
        pronunciationEnabled: entitlements.data.pronunciation.enabled,
        listeningEnabled: entitlements.data.listening.enabled,
      }
    : { writingEnabled: true, pronunciationEnabled: true, listeningEnabled: true };

  useEffect(() => { setSelectedDays(activeWeekdays); }, [activeWeekdays.join(',')]);

  useEffect(() => {
    getMonthSessionTotals(currentYear, currentMonth).then(setConvTotals).catch(() => {});
    getPronunciationDatesForMonth(currentYear, currentMonth)
      .then(setPronunciationDates)
      .catch(() => {});
    getListeningDatesForMonth(currentYear, currentMonth)
      .then((data) => {
        setListeningProgress(data);
        if (listeningRefreshKey > 0) {
          console.log('[LISTENING_CALENDAR_REFRESHED]', { refreshKey: listeningRefreshKey });
        }
      })
      .catch(() => {});
  }, [currentYear, currentMonth, listeningRefreshKey, conversationRefreshKey]);

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
        activeFeatures,
      );
    }
    return map;
  }, [currentYear, currentMonth, entries, convTotals, convGoalSec, pronunciationDates, listeningProgress, activeFeatures]);

  const todayProgress = useMemo(() => computeDailyProgress(
    today,
    entries[today],
    convTotals[today] ?? 0,
    convGoalSec,
    pronunciationDates,
    listeningProgress[today],
    activeFeatures,
  ), [today, entries, convTotals, convGoalSec, pronunciationDates, listeningProgress, activeFeatures]);

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
            const isFuture = dateStr > today;
            const progress = dailyProgressMap[dateStr];

            // Background: green=done, slate-700=today/past-active, slate-800=future or inactive
            const bgCls = progress?.allActiveCompleted
              ? 'bg-green-700'
              : (isInactive || isFuture)
              ? 'bg-slate-800'
              : 'bg-slate-700';

            return (
              <button
                key={dateStr}
                onClick={() => setModalDate(dateStr)}
                className={`
                  aspect-square rounded-md flex flex-col items-center justify-center text-xs font-medium transition-all cursor-pointer
                  ${isInactive ? 'opacity-40' : ''}
                  ${!isInactive && !isToday ? 'hover:ring-1 hover:ring-blue-400' : ''}
                  ${isToday ? 'ring-2 ring-blue-500' : ''}
                  ${bgCls}
                `}
              >
                <span className={
                  isToday
                    ? 'text-white font-bold'
                    : (isFuture && !isInactive)
                    ? 'text-slate-500'
                    : 'text-slate-300'
                }>
                  {date.getDate()}
                </span>
                {/* Show dots only for today and past days — future days have no activity yet */}
                {!isFuture && progress && <DailyProgressIcons progress={progress} />}
              </button>
            );
          })}
        </div>

        {/* Today's checklist */}
        {(() => {
          const activities = [
            { key: 'writing',      label: 'Escrita',     status: todayProgress.writing,      accent: 'text-violet-400', onClick: onOpenWriting,      enabled: activeFeatures.writingEnabled,      optional: false },
            { key: 'pronunciation',label: 'Pronúncia',   status: todayProgress.pronunciation, accent: 'text-blue-400',   onClick: onOpenPronunciation, enabled: activeFeatures.pronunciationEnabled, optional: false },
            { key: 'conversation', label: 'Conversação', status: todayProgress.conversation,  accent: 'text-teal-400',   onClick: onOpenConversation,  enabled: entitlements.data ? entitlements.data.conversation.enabled : true, optional: true },
            { key: 'listening',    label: 'Listening',   status: todayProgress.listening,     accent: 'text-amber-400',  onClick: onOpenListening,     enabled: activeFeatures.listeningEnabled,    optional: false },
          ] as const;

          // Progress mirrors allActiveCompleted's own rule: conversation is
          // never counted (always optional), and a feature disabled by the
          // plan is neither required nor counted against progress.
          const obligatory = activities.filter((a) => !a.optional && a.enabled);
          const completed = obligatory.filter(a => a.status === 'completed').length;
          const pct = obligatory.length > 0 ? (completed / obligatory.length) * 100 : 0;

          return (
            <div className="mt-4 bg-slate-800 rounded-xl overflow-hidden">
              <div className="px-4 pt-3.5 pb-3 border-b border-slate-700">
                <h3 className="text-sm font-semibold text-slate-100">Checklist de hoje</h3>
              </div>

              <div className="divide-y divide-slate-700/50">
                {activities.map(({ key, label, status, accent, onClick, enabled, optional }) => {
                  const done   = enabled && status === 'completed';
                  const inProg = enabled && status === 'in_progress';
                  return (
                    <button
                      key={key}
                      onClick={() => {
                        if (!enabled) { window.alert(ENTITLEMENT_MESSAGES.featureUnavailable); return; }
                        onClick?.();
                      }}
                      aria-disabled={!enabled}
                      className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-slate-700/40 active:bg-slate-700/60 transition-colors text-left"
                    >
                      <span className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 border-2 transition-colors ${
                        done   ? 'bg-green-500 border-green-500' :
                        inProg ? 'border-amber-500 bg-amber-500/10' :
                                 'border-slate-600'
                      }`}>
                        {done   && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
                        {inProg && <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />}
                      </span>
                      <span className={`flex-1 text-sm font-medium ${done ? accent : 'text-slate-200'}`}>
                        {label}
                      </span>
                      {!enabled && (
                        <span className="px-1.5 py-0.5 rounded bg-slate-700 text-slate-500 text-[10px] font-medium shrink-0">
                          Não incluído no plano
                        </span>
                      )}
                      {enabled && optional && (
                        <span className="px-1.5 py-0.5 rounded bg-slate-700 text-slate-400 text-[10px] font-medium shrink-0">
                          Opcional
                        </span>
                      )}
                      <ChevronRight className="w-4 h-4 text-slate-600 shrink-0" />
                    </button>
                  );
                })}
              </div>

              <div className="px-4 py-3 border-t border-slate-700 space-y-2">
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>Progresso de hoje</span>
                  <span className="font-medium text-slate-300">
                    {obligatory.length > 0 ? `${completed} de ${obligatory.length} atividades concluídas` : 'Nenhuma atividade obrigatória no plano'}
                  </span>
                </div>
                <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-500 ease-out"
                    style={{
                      width: `${pct}%`,
                      background: pct >= 100
                        ? 'linear-gradient(to right, #22c55e, #16a34a)'
                        : 'linear-gradient(to right, #3b82f6, #22c55e)',
                    }}
                  />
                </div>
              </div>
            </div>
          );
        })()}

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
          onOpenListening={onOpenListening}
          onClose={() => setModalDate(null)}
        />
      )}
    </>
  );
}
