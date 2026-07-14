import { useState, useEffect } from 'react';
import { View } from './types';
import { useEntries } from './hooks/useEntries';
import { useAuth } from './hooks/useAuth';
import { supabase } from './lib/supabase';
import {
  fetchLearningSettings,
  fetchActiveDayOverrides,
  addLearningDayOverride,
  DEFAULT_SETTINGS,
  LearningSettings,
} from './lib/learningSettings';
import Dashboard from './components/Dashboard';
import MonthView from './components/MonthView';
import YearView from './components/YearView';
import FilterView from './components/FilterView';
import DayView from './components/DayView';
import HistoryView from './components/HistoryView';
import EvolutionView from './components/EvolutionView';
import MemoryView from './components/MemoryView';
import ConversationView from './components/ConversationView';
import AppHeader from './components/AppHeader';
import HamburgerMenu from './components/HamburgerMenu';
import AuthCallback from './components/AuthCallback';
import LoginPage from './components/LoginPage';

export default function App() {
  const today = new Date().toISOString().split('T')[0];
  const [view, setView] = useState<View>('dashboard');
  const [prevView, setPrevView] = useState<View>('dashboard');
  const [selectedDate, setSelectedDate] = useState<string>(today);
  const [currentMonth, setCurrentMonth] = useState(new Date().getMonth() + 1);
  const [currentYear, setCurrentYear] = useState(new Date().getFullYear());
  const [learningSettings, setLearningSettings] = useState<LearningSettings>(DEFAULT_SETTINGS);
  const [monthOverrides, setMonthOverrides] = useState<string[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const { user, loading: authLoading } = useAuth();
  const { entries, loading, syncError, getEntry, saveEntry } = useEntries(user?.id);

  useEffect(() => {
    if (!user) return;
    fetchLearningSettings().then(setLearningSettings).catch(() => {});
    loadMonthOverrides(currentMonth, currentYear);
  }, [user?.id]);

  function loadMonthOverrides(month: number, year: number) {
    fetchActiveDayOverrides(year, month).then(setMonthOverrides).catch(() => {});
  }

  function handleChangeMonth(month: number, year: number) {
    setCurrentMonth(month);
    setCurrentYear(year);
    loadMonthOverrides(month, year);
  }

  async function handleActivateDay(date: string) {
    await addLearningDayOverride(date);
    const m = parseInt(date.slice(5, 7), 10);
    const y = parseInt(date.slice(0, 4), 10);
    loadMonthOverrides(m, y);
  }

  function openDay(date: string) {
    setPrevView(view);
    setSelectedDate(date);
    setView('day');
  }

  function closeDay() {
    setView(prevView);
  }

  function handleLogout() {
    if (user?.id) {
      localStorage.removeItem(`english-calendar-entries-v2-${user.id}`);
    }
    supabase.auth.signOut();
  }

  if (window.location.pathname === '/auth/callback') {
    return <AuthCallback />;
  }

  if (!authLoading && !user) {
    return <LoginPage />;
  }

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-slate-400 text-sm">Carregando...</p>
        </div>
      </div>
    );
  }

  if (view === 'day') {
    return (
      <DayView
        date={selectedDate}
        entry={getEntry(selectedDate)}
        onSave={saveEntry}
        onBack={closeDay}
        activeWeekdays={learningSettings.activeWeekdays}
        onActivateDay={handleActivateDay}
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col">
      <AppHeader onMenuOpen={() => setMenuOpen(true)} onLogoClick={() => setView('dashboard')} />

      {menuOpen && (
        <HamburgerMenu
          current={view}
          onNavigate={setView}
          onClose={() => setMenuOpen(false)}
          onLogout={handleLogout}
        />
      )}

      {syncError && (
        <div className="bg-amber-900/60 border-b border-amber-700 px-4 py-2 text-xs text-amber-200 text-center mt-14">
          {syncError}
        </div>
      )}

      <main className="flex-1 overflow-auto pt-14">
        {view === 'dashboard' && (
          <Dashboard entries={entries} today={today} onOpenDay={openDay} />
        )}
        {view === 'month' && (
          <MonthView
            entries={entries}
            currentMonth={currentMonth}
            currentYear={currentYear}
            onChangeMonth={handleChangeMonth}
            onOpenDay={openDay}
            activeWeekdays={learningSettings.activeWeekdays}
            overrideDates={monthOverrides}
            onSettingsChange={setLearningSettings}
          />
        )}
        {view === 'year' && (
          <YearView
            entries={entries}
            onOpenMonth={(m) => { setCurrentMonth(m); setView('month'); }}
          />
        )}
        {view === 'filters' && (
          <FilterView entries={entries} onOpenDay={openDay} />
        )}
        {view === 'history' && (
          <HistoryView />
        )}
        {view === 'evolution' && (
          <EvolutionView onNavigate={setView} />
        )}
        {view === 'memory' && (
          <MemoryView onNavigate={setView} onSettingsChange={setLearningSettings} />
        )}
        {view === 'conversation' && (
          <ConversationView />
        )}
      </main>
    </div>
  );
}
