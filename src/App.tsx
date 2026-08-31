import { useState, useEffect, useRef } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { isNativeApp, isPluginAvailable } from './lib/runtimeEnvironment';
import { View } from './types';
import { useEntries } from './hooks/useEntries';
import { useAuth } from './hooks/useAuth';
import { useRevenueCatIdentitySync } from './hooks/useRevenueCatIdentitySync';
import { useOneSignalIdentitySync } from './hooks/useOneSignalIdentitySync';
import { usePracticeReminderSync } from './hooks/usePracticeReminderSync';
import {
  setPracticeReminderTapHandler,
  ensurePracticeReminderListeners,
  isPracticeReminderSupported,
} from './lib/notifications/practiceReminderService';
import { useAppsFlyerIdentitySync } from './hooks/useAppsFlyerIdentitySync';
import { usePushPermissionPrompt } from './hooks/usePushPermissionPrompt';
import { supabase } from './lib/supabase';
import { installAccountDeactivationGuard } from './lib/accountDeactivationGuard';
import { endSessionAfterAccountDeletion } from './lib/accountSessionCleanup';
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
import PracticeReminderView from './components/PracticeReminderView';
import PronunciationTrainingView from './components/PronunciationTrainingView';
import ErrorReviewView from './components/ErrorReviewView';
import SettingsView from './components/SettingsView';
import CurriculumPlanView from './components/CurriculumPlanView';
import PlacementOnboarding from './components/placement/PlacementOnboarding';
import { usePlacementStatus } from './hooks/usePlacementStatus';
import { useTutorialStatus } from './hooks/useTutorialStatus';
import HomeTutorial from './components/tutorial/HomeTutorial';
import { useStudyRoutineStatus } from './hooks/useStudyRoutineStatus';
import StudyRoutineOnboarding from './components/studyRoutine/StudyRoutineOnboarding';
import StudyRoutineView from './components/studyRoutine/StudyRoutineView';
import SubscriptionView from './components/SubscriptionView';
import SubscriptionGatePopup from './components/SubscriptionGatePopup';
import MinutePackagesView from './components/MinutePackagesView';
import AppHeader from './components/AppHeader';
import HamburgerMenu from './components/HamburgerMenu';
import AuthCallback from './components/AuthCallback';
import LoginPage from './components/LoginPage';
import ResetPasswordPage from './components/ResetPasswordPage';
import MaintenanceBanner from './components/MaintenanceBanner';

// Installed once at module load — reacts to ACCOUNT_DEACTIVATED from any
// authenticated API call, from anywhere in the app, by ending the session.
installAccountDeactivationGuard();

export default function App() {
  const today = getTodaySP();
  const [view, setView] = useState<View>('home');
  const [prevView, setPrevView] = useState<View>('home');
  // Where "Minutos adicionais" returns to (it's reachable from both the
  // subscription screen and the conversation area — one screen, two entries).
  const [minutesReturnView, setMinutesReturnView] = useState<View>('home');
  const openMinutePackages = (from: View) => { setMinutesReturnView(from); setView('minute-packages'); };
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
  useRevenueCatIdentitySync(user?.id);
  useOneSignalIdentitySync(user?.id);
  useAppsFlyerIdentitySync(user?.id);
  // Keeps the device's local practice-reminder schedules in lockstep with the
  // session (login restores, logout cancels) and re-heals them on resume.
  usePracticeReminderSync(user?.id);
  // Tapping a practice reminder should bring the user to a useful practice area.
  // The reminder is general (not a specific activity), so we route to Home — the
  // hub of all practices. Registered once at boot (native-only) so a tap that
  // cold-starts the app is caught; a warm tap just foregrounds + lands on Home.
  useEffect(() => {
    if (!isPracticeReminderSupported()) return;
    setPracticeReminderTapHandler(() => setView('home'));
    void ensurePracticeReminderListeners();
    return () => setPracticeReminderTapHandler(null);
  }, []);
  const { entries, loading, syncError, getEntry, saveEntry } = useEntries(user?.id);
  const { status: placementStatus, loading: placementLoading, refresh: refreshPlacement } = usePlacementStatus(user?.id);
  // Server-persisted first-run tutorial status. 'pending' (incl. a brand-new
  // account with no row) → the Home walkthrough should auto-run once; existing
  // users backfilled to 'completed' by the rollout migration never see it.
  const {
    status: tutorialStatus,
    loading: tutorialLoading,
    complete: completeTutorial,
    skip: skipTutorial,
  } = useTutorialStatus(user?.id);
  // `tutorialActive` = the walkthrough overlay is on screen; `tutorialReplay` =
  // this run was launched from Configurações → "Ver tutorial novamente", so
  // finishing/skipping it must NOT overwrite the persisted status.
  const [tutorialActive, setTutorialActive] = useState(false);
  const [tutorialReplay, setTutorialReplay] = useState(false);
  const tutorialAutoShownRef = useRef(false);
  const tutorialBackRef = useRef<(() => void) | null>(null);
  // Server-persisted MANDATORY study-routine setup status. 'unconfigured' (incl.
  // a brand-new account with no row) → the config gate must run once, right after
  // the tutorial, before releasing the Home (§1). Existing users are grandfathered
  // to 'configured' by the rollout migration, so they never see it.
  const {
    status: studyRoutineStatus,
    markConfigured: markStudyRoutineConfigured,
  } = useStudyRoutineStatus(user?.id);
  const studyRoutineBackRef = useRef<(() => void) | null>(null);

  // First-run push permission ask (native only). True exactly when the app has
  // cleared every blocking gate below — authenticated, past the auth/entries
  // spinners and the placement-onboarding gate — i.e. the real Home experience
  // is on screen. Kept in sync with those same `return`s so the OS prompt never
  // fires on login, a splash, or during onboarding (ETAPA 5).
  const placementReleased =
    !(placementLoading && placementStatus === null) && placementStatus !== 'not_started';
  const atHomeExperience = !!user && !authLoading && !loading && placementReleased;
  // The native push prompt must WAIT for the tutorial (§10) AND for the mandatory
  // study-routine setup: a brand-new user sees auth → placement → tutorial →
  // study-routine config, and only AFTER all of those may the push flow continue
  // (the OS prompt must never fire over the tutorial or the config wizard). So
  // suppress it while the tutorial is still pending/on screen or while the
  // study-routine config is still unconfigured. A backend error (status stays
  // null, not loading) is treated as "settled" so a transient failure never
  // permanently blocks the existing push flow.
  const tutorialShouldRun = tutorialStatus === 'pending';
  const readyForPush =
    atHomeExperience && !tutorialActive && !tutorialLoading && !tutorialShouldRun &&
    studyRoutineStatus !== 'unconfigured';
  usePushPermissionPrompt(readyForPush);

  // The MANDATORY study-routine setup runs strictly AFTER the tutorial has
  // settled (never while it is pending/active — the walkthrough must play on the
  // real Home first) and BEFORE the Home is released. It only fires on an explicit
  // 'unconfigured' status, so a transient read failure (null) never traps the user
  // behind it — it simply re-appears next launch while still unconfigured (§3).
  const tutorialSettled =
    !tutorialLoading && tutorialStatus !== 'pending' && !tutorialActive;
  const studyRoutineGateActive =
    atHomeExperience && tutorialSettled && studyRoutineStatus === 'unconfigured';

  async function handleStudyRoutineComplete() {
    await markStudyRoutineConfigured();
    // Reflect any change to the practice days in the app's in-memory state so the
    // calendar/home/streak update immediately (same source of truth, no reload).
    fetchLearningSettings().then(setLearningSettings).catch(() => {});
  }

  // Auto-run the walkthrough exactly once per session, only on the real Home,
  // never over the menu/another modal, and only for a 'pending' user (§7).
  useEffect(() => {
    if (
      atHomeExperience &&
      view === 'home' &&
      !menuOpen &&
      !tutorialLoading &&
      tutorialStatus === 'pending' &&
      !tutorialActive &&
      !tutorialAutoShownRef.current
    ) {
      tutorialAutoShownRef.current = true;
      setTutorialReplay(false);
      setTutorialActive(true);
    }
  }, [atHomeExperience, view, menuOpen, tutorialLoading, tutorialStatus, tutorialActive]);

  function handleTutorialComplete() {
    setTutorialActive(false);
    if (!tutorialReplay) void completeTutorial();
    setTutorialReplay(false);
  }
  function handleTutorialSkip() {
    setTutorialActive(false);
    if (!tutorialReplay) void skipTutorial();
    setTutorialReplay(false);
  }
  // Configurações → "Ver tutorial novamente": replays on the Home WITHOUT
  // changing the persisted status (a completed user stays completed).
  function startTutorialReplay() {
    setMenuOpen(false);
    setView('home');
    setTutorialReplay(true);
    setTutorialActive(true);
  }

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

  async function handleAccountDeleted() {
    await endSessionAfterAccountDeletion();
  }

  // Android hardware back button — priority order: close an open modal/menu,
  // then WebView navigation history (canGoBack, relevant now that the remote
  // site could push real history entries), then the app's own view stack,
  // then exit only from the root. Capacitor's default (no listener at all)
  // would just close the app from any screen.
  const backButtonStateRef = useRef({ menuOpen, view, prevView, tutorialActive, studyRoutineGateActive });
  backButtonStateRef.current = { menuOpen, view, prevView, tutorialActive, studyRoutineGateActive };

  useEffect(() => {
    if (!isNativeApp || !isPluginAvailable('App')) return;

    const listenerPromise = CapacitorApp.addListener('backButton', ({ canGoBack }) => {
      const { menuOpen: isMenuOpen, view: currentView, prevView: previousView, tutorialActive: isTutorialActive, studyRoutineGateActive: isRoutineGate } = backButtonStateRef.current;
      // The MANDATORY study-routine setup owns the back button while it gates the
      // Home: step 2 → step 1, and on step 1 it is a no-op — the user can never
      // escape to the Home before completing it (§3).
      if (isRoutineGate) {
        studyRoutineBackRef.current?.();
        return;
      }
      // The walkthrough owns the back button while it is on screen: previous step,
      // or skip on the first step — never falls through to menu/app navigation
      // (so the user is never left stuck behind the overlay, §6).
      if (isTutorialActive) {
        tutorialBackRef.current?.();
        return;
      }
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

  // Must be checked before the !user gate below: a Supabase recovery link
  // establishes a session, which would otherwise make this render the main
  // app instead of the reset-password form.
  if (window.location.pathname === '/reset-password') {
    return <ResetPasswordPage />;
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

  // Post-signup onboarding GATE: a brand-new user (server-persisted
  // placement_status = not_started, never localStorage) sees the level test
  // BEFORE Home. Skipping or finishing refreshes the status and releases the
  // app. While the status is still loading we hold on the spinner so Home never
  // flashes before the gate; if placement is unavailable the status resolves to
  // a non-"not_started" value and the app opens normally (never blocked).
  if (user && placementLoading && placementStatus === null) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (user && placementStatus === 'not_started') {
    return <PlacementOnboarding onFinished={refreshPlacement} />;
  }
  // "Teste de nível" opened from the menu (placement not yet completed).
  if (view === 'placement') {
    return (
      <PlacementOnboarding
        onFinished={() => { refreshPlacement(); setView('home'); }}
        onExit={() => setView('home')}
      />
    );
  }

  // MANDATORY study-routine setup GATE (§1/§3): runs once, immediately AFTER the
  // Home tutorial settles and BEFORE the Home is released. Full-screen and
  // non-dismissible; the completion flag is server-persisted so it survives
  // reload/reinstall/logout and other devices. Existing users are grandfathered
  // to 'configured' by the rollout migration and never see this.
  if (studyRoutineGateActive) {
    return (
      <StudyRoutineOnboarding
        onComplete={handleStudyRoutineComplete}
        registerBackHandler={(fn) => { studyRoutineBackRef.current = fn; }}
      />
    );
  }

  if (view === 'day') {
    return (
      <DayView
        date={selectedDate}
        entry={getEntry(selectedDate)}
        onSave={saveEntry}
        onBack={closeDay}
        onNavigateToSubscription={() => setView('subscription')}
        activeWeekdays={learningSettings.activeWeekdays}
        onActivateDay={handleActivateDay}
      />
    );
  }

  // Internal activity screens render their OWN standardized ScreenHeader (back
  // arrow + Orodim logo), so the global chrome header (hamburger + logo) is not
  // shown for them — otherwise the screen would stack two bars. The content
  // offset is dropped for these too, since the ScreenHeader is sticky and owns
  // the safe-area inset itself.
  const usesOwnHeader =
    view === 'conversation' || view === 'listening' ||
    view === 'pronunciation-training' || view === 'error-review' ||
    view === 'practice-reminder' || view === 'study-routine';
  const headerOffset = usesOwnHeader ? undefined : 'calc(3.5rem + env(safe-area-inset-top))';

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col">
      {!usesOwnHeader && (
        <AppHeader onMenuOpen={() => setMenuOpen(true)} onLogoClick={() => setView('home')} />
      )}

      {menuOpen && (
        <HamburgerMenu
          current={view}
          onNavigate={setView}
          onClose={() => setMenuOpen(false)}
          onLogout={handleLogout}
          showPlacement={placementStatus !== null && placementStatus !== 'completed'}
        />
      )}

      <MaintenanceBanner />

      {syncError && (
        <div
          className="bg-amber-900/60 border-b border-amber-700 px-4 py-2 text-xs text-amber-200 text-center"
          style={{ marginTop: headerOffset }}
        >
          {syncError}
        </div>
      )}

      <main
        className="flex-1 overflow-auto"
        style={{ paddingTop: headerOffset }}
      >
        {view === 'home' && (
          <HomePage
            onNavigate={setView}
            onStartPractice={() => openDay(today)}
            activeWeekdays={learningSettings.activeWeekdays}
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
          <ConversationView
            onBack={() => setView('home')}
            onComplete={() => setConversationRefreshKey((k) => k + 1)}
            onNavigateToSubscription={() => setView('subscription')}
            onNavigateToMinutePackages={() => openMinutePackages('conversation')}
          />
        )}
        {view === 'listening' && (
          <ListeningView
            onBack={() => setView('home')}
            episodeId={listeningEpisodeId}
            onComplete={() => {
              setListeningRefreshKey((k) => k + 1);
              console.log('[LISTENING_CALENDAR_REFRESHED] calendar refresh triggered after listening completion');
            }}
            onNavigateToSubscription={() => setView('subscription')}
          />
        )}
        {view === 'audio-settings' && (
          <AudioSettingsView onBack={() => setView('home')} />
        )}
        {view === 'practice-reminder' && (
          <PracticeReminderView onBack={() => setView('home')} />
        )}
        {view === 'pronunciation-training' && (
          <PronunciationTrainingView onBack={() => setView('home')} onNavigateToSubscription={() => setView('subscription')} />
        )}
        {view === 'error-review' && (
          <ErrorReviewView onBack={() => setView('home')} />
        )}
        {view === 'settings' && (
          <SettingsView
            onBack={() => setView('home')}
            onAccountDeleted={handleAccountDeleted}
            onReplayTutorial={startTutorialReplay}
          />
        )}
        {view === 'curriculum-plan' && (
          <CurriculumPlanView onBack={() => setView('home')} />
        )}
        {view === 'study-routine' && (
          <StudyRoutineView
            onBack={() => setView('home')}
            onSettingsChange={setLearningSettings}
          />
        )}
        {view === 'subscription' && (
          <SubscriptionView
            onBack={() => setView('home')}
            onNavigateToMinutePackages={() => openMinutePackages('subscription')}
          />
        )}
        {view === 'minute-packages' && (
          <MinutePackagesView
            onBack={() => setView(minutesReturnView)}
            onNavigateToSubscription={() => setView('subscription')}
          />
        )}
      </main>

      {/* Proactive access-ended gate — offers a plan once the trial ran out or a
          subscription lapsed. Overlays any view; suppressed on the subscription
          screen itself (where the plans are already the focus). */}
      <SubscriptionGatePopup
        onNavigateToSubscription={() => setView('subscription')}
        suppressed={view === 'subscription'}
      />

      {/* First-run interactive Home walkthrough. Mounts only while active (auto on
          first run, or replayed from Configurações) and always over the real Home
          — it spotlights Home/header elements by their data-tour anchors. */}
      {tutorialActive && (
        <HomeTutorial
          open={tutorialActive}
          onComplete={handleTutorialComplete}
          onSkip={handleTutorialSkip}
          registerBackHandler={(fn) => {
            tutorialBackRef.current = fn;
          }}
        />
      )}
    </div>
  );
}
