import { useState } from 'react';
import { View } from './types';
import { useEntries } from './hooks/useEntries';
import { useAuth } from './hooks/useAuth';
import { supabase } from './lib/supabase';
import Dashboard from './components/Dashboard';
import MonthView from './components/MonthView';
import YearView from './components/YearView';
import FilterView from './components/FilterView';
import DayView from './components/DayView';
import HistoryView from './components/HistoryView';
import EvolutionView from './components/EvolutionView';
import MemoryView from './components/MemoryView';
import BottomNav from './components/BottomNav';
import AuthCallback from './components/AuthCallback';
import LoginPage from './components/LoginPage';

export default function App() {
  const today = new Date().toISOString().split('T')[0];
  const [view, setView] = useState<View>('dashboard');
  const [prevView, setPrevView] = useState<View>('dashboard');
  const [selectedDate, setSelectedDate] = useState<string>(today);
  const [currentMonth, setCurrentMonth] = useState(new Date().getMonth() + 1);
  const [currentYear, setCurrentYear] = useState(new Date().getFullYear());
  const { user, loading: authLoading } = useAuth();
  const { entries, loading, syncError, getEntry, saveEntry } = useEntries(user?.id);

  function openDay(date: string) {
    setPrevView(view);
    setSelectedDate(date);
    setView('day');
  }

  function closeDay() {
    setView(prevView);
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
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col">
      {syncError && (
        <div className="bg-amber-900/60 border-b border-amber-700 px-4 py-2 text-xs text-amber-200 text-center">
          {syncError}
        </div>
      )}
      <main className="flex-1 overflow-auto pb-16">
        {view === 'dashboard' && (
          <Dashboard entries={entries} today={today} onOpenDay={openDay} />
        )}
        {view === 'month' && (
          <MonthView
            entries={entries}
            currentMonth={currentMonth}
            currentYear={currentYear}
            onChangeMonth={(m, y) => { setCurrentMonth(m); setCurrentYear(y); }}
            onOpenDay={openDay}
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
          <MemoryView onNavigate={setView} />
        )}
      </main>
      <BottomNav current={view} onChange={setView} />
      <button
        onClick={() => {
          if (user?.id) {
            localStorage.removeItem(`english-calendar-entries-v2-${user.id}`);
          }
          supabase.auth.signOut();
        }}
        className="fixed top-3 right-4 text-xs text-slate-600 hover:text-slate-400 transition-colors z-50"
      >
        Sair
      </button>
    </div>
  );
}
