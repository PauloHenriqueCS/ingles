import { useState } from 'react';
import { View } from './types';
import { useEntries } from './hooks/useEntries';
import Dashboard from './components/Dashboard';
import MonthView from './components/MonthView';
import YearView from './components/YearView';
import FilterView from './components/FilterView';
import DayView from './components/DayView';
import BottomNav from './components/BottomNav';

export default function App() {
  const today = new Date().toISOString().split('T')[0];
  const [view, setView] = useState<View>('dashboard');
  const [prevView, setPrevView] = useState<View>('dashboard');
  const [selectedDate, setSelectedDate] = useState<string>(today);
  const [currentMonth, setCurrentMonth] = useState(new Date().getMonth() + 1);
  const [currentYear, setCurrentYear] = useState(new Date().getFullYear());
  const { entries, getEntry, saveEntry } = useEntries();

  function openDay(date: string) {
    setPrevView(view);
    setSelectedDate(date);
    setView('day');
  }

  function closeDay() {
    setView(prevView);
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
      </main>
      <BottomNav current={view} onChange={setView} />
    </div>
  );
}
