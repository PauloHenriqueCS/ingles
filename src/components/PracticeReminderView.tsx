import { useEffect, useState } from 'react';
import { Bell, Loader2, AlertCircle, Check, BellOff } from 'lucide-react';
import ScreenHeader from './ScreenHeader';
import { isNativeApp } from '../lib/runtimeEnvironment';
import { useCurriculumFocus } from '../hooks/useCurriculumFocus';
import { buildReminderCopy } from '../lib/notifications/practiceReminderCopy';
import { practiceReminderUiStrings } from '../i18n/practiceReminderUiStrings';
import {
  fetchPracticeReminder,
  savePracticeReminder,
} from '../lib/practiceReminder';
import {
  DEFAULT_PRACTICE_REMINDER,
  WEEKDAY_ORDER,
  formatTime,
  parseTime,
  summarizeWeekdays,
  type PracticeReminderPreference,
} from '../domain/practiceReminder/practiceReminder';
import {
  getPracticeReminderPermission,
  requestPracticeReminderPermission,
  syncPracticeReminders,
  cancelPracticeReminders,
  isPracticeReminderSupported,
  type NotificationPermission,
} from '../lib/notifications/practiceReminderService';

interface Props {
  onBack: () => void;
  /** Optional override; otherwise resolved from the curriculum progress payload. */
  interfaceLanguage?: string | null;
}

type LoadState = 'loading' | 'done' | 'error';
type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';
type PermissionUi = NotificationPermission | 'unsupported' | 'unknown';

export default function PracticeReminderView({ onBack, interfaceLanguage }: Props) {
  // Resolve the UI language from the OFFICIAL source (same as Home), with the
  // prop as an optional override — so the screen chrome AND the saved
  // notification copy match the user's interface language.
  const focus = useCurriculumFocus();
  const lang = interfaceLanguage ?? focus.data?.interfaceLanguage ?? null;
  const t = practiceReminderUiStrings(lang);
  const conjunction = (lang ?? '').startsWith('en') ? 'and' : 'e';

  const [pref, setPref] = useState<PracticeReminderPreference>(DEFAULT_PRACTICE_REMINDER);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [permission, setPermission] = useState<PermissionUi>('unknown');
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchPracticeReminder()
      .then((p) => {
        if (!active) return;
        setPref(p);
        setLoadState('done');
      })
      .catch(() => active && setLoadState('error'));
    getPracticeReminderPermission().then((p) => active && setPermission(p));
    return () => {
      active = false;
    };
  }, []);

  const timeValue = formatTime(pref.hour, pref.minute);
  const summary =
    pref.enabled && pref.weekdays.length > 0
      ? t.summaryEnabled(summarizeWeekdays(pref.weekdays, t.weekdayShort, conjunction), timeValue)
      : t.summaryDisabled;

  function toggleEnabled() {
    setSaveStatus('idle');
    setValidationError(null);
    setPref((p) => ({ ...p, enabled: !p.enabled }));
  }

  function toggleWeekday(isoDay: number) {
    setSaveStatus('idle');
    setValidationError(null);
    setPref((p) => {
      const has = p.weekdays.includes(isoDay);
      const weekdays = has
        ? p.weekdays.filter((d) => d !== isoDay)
        : [...p.weekdays, isoDay].sort((a, b) => a - b);
      return { ...p, weekdays };
    });
  }

  function onTimeChange(value: string) {
    setSaveStatus('idle');
    const { hour, minute } = parseTime(value);
    setPref((p) => ({ ...p, hour, minute }));
  }

  async function handleSave() {
    // Never allow an active-but-invalid state (§11).
    if (pref.enabled && pref.weekdays.length === 0) {
      setValidationError(t.validationNeedDay);
      return;
    }
    setValidationError(null);
    setSaveStatus('saving');

    try {
      // 1) On native + enabling: ensure permission BEFORE claiming it works (§4).
      let effectivePermission: PermissionUi = permission;
      if (isPracticeReminderSupported() && pref.enabled) {
        effectivePermission = await getPracticeReminderPermission();
        if (effectivePermission === 'prompt') {
          effectivePermission = await requestPracticeReminderPermission();
        }
        setPermission(effectivePermission);
      }

      // 2) Persist the desired configuration (server = source of truth) — always,
      //    even when permission was denied (so it survives and can be honored
      //    once the user enables notifications in system settings).
      const saved = await savePracticeReminder(pref);
      setPref(saved);

      // 3) Reconcile the DEVICE schedules with the saved intent.
      if (isPracticeReminderSupported()) {
        if (saved.enabled && effectivePermission === 'granted') {
          await syncPracticeReminders(saved, buildReminderCopy(lang));
        } else {
          // Disabled, or enabled-but-blocked: clear our reserved reminders so
          // nothing fires. The denied banner (below) explains the block.
          await cancelPracticeReminders();
        }
      }

      setSaveStatus('saved');
    } catch {
      setSaveStatus('error');
    }
  }

  if (loadState === 'loading') {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col">
        <ScreenHeader onBack={onBack} title={t.title} />
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-6 h-6 text-slate-500 animate-spin" />
        </div>
      </div>
    );
  }

  if (loadState === 'error') {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col">
        <ScreenHeader onBack={onBack} title={t.title} />
        <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center">
          <AlertCircle className="w-8 h-8 text-red-400 shrink-0" />
          <p className="text-slate-300 text-sm">Não foi possível carregar o lembrete.</p>
        </div>
      </div>
    );
  }

  const showDeniedBanner =
    pref.enabled && isPracticeReminderSupported() && permission === 'denied';

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      <ScreenHeader onBack={onBack} title={t.title} />

      <div className="flex-1 overflow-auto p-4 max-w-lg mx-auto w-full space-y-5 pb-32">
        <p className="text-sm text-slate-400">{t.intro}</p>

        {/* Enable toggle + live summary */}
        <section className="bg-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5 min-w-0">
              <p className="text-sm font-medium text-slate-200">{t.toggleLabel}</p>
              <p className="text-xs text-slate-500">{summary}</p>
            </div>
            <button
              role="switch"
              aria-checked={pref.enabled}
              aria-label={t.toggleLabel}
              onClick={toggleEnabled}
              className={`relative shrink-0 w-11 h-6 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-slate-800 ${
                pref.enabled ? 'bg-blue-600' : 'bg-slate-600'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                  pref.enabled ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        </section>

        {/* Weekday chips + time — only meaningful while enabled */}
        <section
          className={`bg-slate-800 rounded-xl p-5 space-y-5 transition-opacity ${
            pref.enabled ? '' : 'opacity-40 pointer-events-none'
          }`}
          aria-hidden={!pref.enabled}
        >
          <div className="space-y-3">
            <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">
              {t.weekdaysLabel}
            </p>
            <div className="grid grid-cols-7 gap-1.5">
              {WEEKDAY_ORDER.map((d) => {
                const selected = pref.weekdays.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => toggleWeekday(d)}
                    aria-pressed={selected}
                    aria-label={t.weekdayLong(d)}
                    className={`h-10 rounded-lg text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                      selected
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                    }`}
                  >
                    {t.weekdayShort(d)}
                  </button>
                );
              })}
            </div>
            {validationError && <p className="text-xs text-red-400">{validationError}</p>}
          </div>

          <div className="space-y-2">
            <label
              htmlFor="practice-reminder-time"
              className="block text-xs text-slate-400 font-medium uppercase tracking-wider"
            >
              {t.timeLabel}
            </label>
            <input
              id="practice-reminder-time"
              type="time"
              value={timeValue}
              onChange={(e) => onTimeChange(e.target.value)}
              className="w-full sm:w-40 bg-slate-700 text-slate-100 text-lg rounded-lg px-3 py-2 border border-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </section>

        {/* Permission-denied guidance (§4.6) */}
        {showDeniedBanner && (
          <section className="bg-amber-900/20 border border-amber-800/40 rounded-xl p-4 flex gap-3">
            <BellOff className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-amber-200">{t.permissionDeniedTitle}</p>
              <p className="text-xs text-amber-200/80">{t.permissionDeniedBody}</p>
            </div>
          </section>
        )}

        {/* Web note — the notification only fires in the mobile app (§16) */}
        {!isNativeApp && (
          <p className="text-xs text-slate-500 flex items-start gap-2">
            <Bell className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            {t.webUnsupportedNote}
          </p>
        )}
      </div>

      {/* Save bar */}
      <div
        className="fixed bottom-0 left-0 right-0 bg-slate-900/95 border-t border-slate-700 p-4"
        style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}
      >
        <div className="max-w-lg mx-auto flex items-center gap-3">
          {saveStatus === 'error' && (
            <p className="text-xs text-red-400 flex-1">Não foi possível salvar. Tente novamente.</p>
          )}
          {saveStatus === 'saved' && (
            <p className="text-xs text-green-400 flex-1 flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5 shrink-0" />
              {t.savedFeedback}
            </p>
          )}
          {(saveStatus === 'idle' || saveStatus === 'saving') && <div className="flex-1" />}
          <button
            onClick={handleSave}
            disabled={saveStatus === 'saving'}
            className="px-6 py-2.5 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            {saveStatus === 'saving' && <Loader2 className="w-4 h-4 animate-spin shrink-0" />}
            {saveStatus === 'saving' ? t.savingButton : t.saveButton}
          </button>
        </div>
      </div>
    </div>
  );
}
