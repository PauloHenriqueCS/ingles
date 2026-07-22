import { useState, useEffect, useRef } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { isNativeApp, isPluginAvailable } from './lib/runtimeEnvironment';
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
import { getTodaySP, getSpMonth, getSpYear } from './lib/timezone';
import HomePage from './components/HomePage';
import Dashboard from './components/Dashboard';
import MonthView from './components/MonthView';
import DayView from './components/DayView';
import HistoryView from './components/HistoryView';
import EvolutionView from './components/EvolutionView';
import MemoryView from './components/MemoryView';
import ConversationView from './components/ConversationView';
import ListeningView from './components/ListeningView';
import AudioSettingsView from './components/AudioSettingsView';
import PronunciationTrainingView from './components/PronunciationTrainingView';
import AppHeader from './components/AppHeader';
import HamburgerMenu from './components/HamburgerMenu';
import AuthCallback from './components/AuthCallback';
import LoginPage from './components/LoginPage';

export default function App() {
  const today = getTodaySP();
  const [view, setView] = useState<View>('home');
  const [prevView, setPrevView] = useState<View>('home');
  const [selectedDate, setSelectedDate] = useState<string>(today);
  const [currentMonth, setCurrentMonth] = useState(getSpMonth());
  const [currentYear, setCurrentYear] = useState(getSpYear());
  const [learningSettings, setLearningSettings] = useState<LearningSettings>(DEFAULT_SETTINGS);
  const [monthOverrides, setMonthOverrides] = useState<string[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [listeningEpisodeId] = useState<string | undefined>(undefined);
  const [listeningRefreshKey, setListeningRefreshKey] = useState(0);
  const [conversationRefreshKey, setConversationRefreshKey] = useState(0);
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

  // Android hardware back button — priority order: close an open modal/menu,
  // then WebView navigation history (canGoBack, relevant now that the remote
  // site could push real history entries), then the app's own view stack,
  // then exit only from the root. Capacitor's default (no listener at all)
  // would just close the app from any screen.
  const backButtonStateRef = useRef({ menuOpen, view, prevView });
  backButtonStateRef.current = { menuOpen, view, prevView };

  useEffect(() => {
    if (!isNativeApp || !isPluginAvailable('App')) return;

    const listenerPromise = CapacitorApp.addListener('backButton', ({ canGoBack }) => {
      const { menuOpen: isMenuOpen, view: currentView, prevView: previousView } = backButtonStateRef.current;
      if (isMenuOpen) {
        setMenuOpen(false);
      } else if (canGoBack) {
        window.history.back();
      } else if (currentView === 'day') {
        setView(previousView);
      } else if (currentView !== 'home') {
        setView('home');
      } else {
        CapacitorApp.exitApp();
      }
    });

    return () => {
      listenerPromise.then((listener) => listener.remove());
    };
  }, []);

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
      <AppHeader onMenuOpen={() => setMenuOpen(true)} onLogoClick={() => setView('home')} />

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
        {view === 'home' && (
          <HomePage
            onNavigate={setView}
            onStartPractice={() => openDay(today)}
          />
        )}
        {view === 'dashboard' && (
          <Dashboard
            entries={entries}
            today={today}
            onOpenDay={openDay}
            onNavigate={setView}
            activeWeekdays={learningSettings.activeWeekdays}
          />
        )}
        {view === 'month' && (
          <MonthView
            entries={entries}
            currentMonth={currentMonth}
            currentYear={currentYear}
            onChangeMonth={handleChangeMonth}
            onOpenDay={openDay}
            onOpenWriting={() => openDay(today)}
            onOpenPronunciation={() => setView('pronunciation-training')}
            onOpenConversation={() => setView('conversation')}
            onOpenListening={() => setView('listening')}
            listeningRefreshKey={listeningRefreshKey}
            conversationRefreshKey={conversationRefreshKey}
            activeWeekdays={learningSettings.activeWeekdays}
            overrideDates={monthOverrides}
            onSettingsChange={setLearningSettings}
          />
        )}
        {view === 'year' && (
          <MonthView
            entries={entries}
            currentMonth={currentMonth}
            currentYear={currentYear}
            onChangeMonth={handleChangeMonth}
            onOpenDay={openDay}
            onOpenWriting={() => openDay(today)}
            onOpenPronunciation={() => setView('pronunciation-training')}
            onOpenConversation={() => setView('conversation')}
            onOpenListening={() => setView('listening')}
            listeningRefreshKey={listeningRefreshKey}
            conversationRefreshKey={conversationRefreshKey}
            activeWeekdays={learningSettings.activeWeekdays}
            overrideDates={monthOverrides}
            onSettingsChange={setLearningSettings}
          />
        )}
        {(view === 'filters' || view === 'history') && (
          <HistoryView entries={entries} onOpenDay={openDay} />
        )}
        {view === 'evolution' && (
          <EvolutionView onNavigate={setView} />
        )}
        {view === 'memory' && (
          <MemoryView onNavigate={setView} onSettingsChange={setLearningSettings} />
        )}
        {view === 'conversation' && (
          <ConversationView onComplete={() => setConversationRefreshKey((k) => k + 1)} />
        )}
        {view === 'listening' && (
          <ListeningView
            onBack={() => setView('home')}
            episodeId={listeningEpisodeId}
            onComplete={() => {
              setListeningRefreshKey((k) => k + 1);
              console.log('[LISTENING_CALENDAR_REFRESHED] calendar refresh triggered after listening completion');
            }}
          />
        )}
        {view === 'audio-settings' && (
          <AudioSettingsView onBack={() => setView('home')} />
        )}
        {view === 'pronunciation-training' && (
          <PronunciationTrainingView onBack={() => setView('home')} />
        )}
      </main>
    </div>
  );
}
