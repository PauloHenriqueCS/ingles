import { useState, useEffect } from 'react';
import { PenSquare, Headphones, AudioLines, MessagesSquare, AlertCircle, Check, Loader2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  getCurriculumPreferences,
  updateCurriculumPreferences,
  type CurriculumModalities,
  type ModalityKey,
} from '../lib/curriculumApi';
import { curriculumUiStrings } from '../i18n/curriculumUiStrings';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface ModalityDef {
  key: ModalityKey;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Extra emphasis text always shown under the description. */
  warning?: string;
}

const MODALITY_ICONS: Record<ModalityKey, LucideIcon> = {
  writing: PenSquare,
  listening: Headphones,
  pronunciation: AudioLines,
  conversation: MessagesSquare,
};

function countSelected(m: CurriculumModalities): number {
  return Object.values(m).filter(Boolean).length;
}

export default function CurriculumModalityPreferences() {
  const [modalities, setModalities] = useState<CurriculumModalities | null>(null);
  const [interfaceLanguage, setInterfaceLanguage] = useState<string | null>(null);
  // Data-driven display name of the taught language (blocker 16) — used in the
  // conversation description instead of any hardcoded "inglês".
  const [learningLanguageLabel, setLearningLanguageLabel] = useState<string>('');
  const [loadState, setLoadState] = useState<'loading' | 'done' | 'error'>('loading');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [validationMsg, setValidationMsg] = useState<string | null>(null);

  const t = curriculumUiStrings(interfaceLanguage);
  const MODALITIES: ModalityDef[] = [
    { key: 'writing', label: t.modalityWriting, description: t.descWriting, icon: MODALITY_ICONS.writing },
    { key: 'listening', label: t.modalityListening, description: t.descListening, icon: MODALITY_ICONS.listening },
    { key: 'pronunciation', label: t.modalityPronunciation, description: t.descPronunciation, icon: MODALITY_ICONS.pronunciation },
    { key: 'conversation', label: t.modalityConversation, description: t.descConversation(learningLanguageLabel), icon: MODALITY_ICONS.conversation, warning: t.warnConversation },
  ];

  function load() {
    setLoadState('loading');
    getCurriculumPreferences()
      .then((prefs) => {
        setModalities(prefs.modalities);
        setInterfaceLanguage(prefs.interfaceLanguage);
        setLearningLanguageLabel(prefs.learningLanguageLabel);
        setLoadState('done');
      })
      .catch(() => setLoadState('error'));
  }

  useEffect(() => { load(); }, []);

  async function handleToggle(key: ModalityKey) {
    if (!modalities) return;
    const next: CurriculumModalities = { ...modalities, [key]: !modalities[key] };

    // "menu = regra" — but the menu can never be empty: at least one modality
    // must stay required to advance a recorte.
    if (countSelected(next) === 0) {
      setValidationMsg(t.atLeastOne);
      return;
    }

    setValidationMsg(null);
    const previous = modalities;
    setModalities(next); // optimistic
    setSaveStatus('saving');
    try {
      const res = await updateCurriculumPreferences({ [key]: next[key] });
      setModalities(res.modalities);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch {
      setModalities(previous); // revert
      setSaveStatus('error');
    }
  }

  return (
    <section className="bg-slate-800 rounded-xl p-5 space-y-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold text-slate-100">{t.modalitiesTitle}</h2>
        <p className="text-xs text-slate-400 leading-relaxed">
          {t.modalitiesIntro(t.modalitiesIntroEmphasis)}
        </p>
      </div>

      {loadState === 'loading' && (
        <div className="flex items-center gap-2 py-4 text-slate-400 text-sm">
          <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" />
          {t.loadingPrefs}
        </div>
      )}

      {loadState === 'error' && (
        <div className="bg-red-900/30 border border-red-800 rounded-lg p-4 text-center space-y-2">
          <p className="text-red-300 text-sm">{t.prefsLoadError}</p>
          <button onClick={load} className="text-xs text-slate-400 hover:text-slate-200 transition-colors">
            {t.retry}
          </button>
        </div>
      )}

      {loadState === 'done' && modalities && (
        <>
          <div className="space-y-3">
            {MODALITIES.map(({ key, label, description, icon: Icon, warning }) => {
              const checked = modalities[key];
              return (
                <div
                  key={key}
                  className={`rounded-xl border p-4 transition-colors ${
                    checked ? 'bg-slate-700/40 border-slate-600' : 'bg-slate-800 border-slate-700'
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3 min-w-0">
                      <div className={`flex items-center justify-center w-9 h-9 rounded-lg shrink-0 ${
                        checked ? 'bg-blue-600/20 text-blue-300' : 'bg-slate-700 text-slate-400'
                      }`}>
                        <Icon className="w-5 h-5 shrink-0" strokeWidth={2} aria-hidden="true" />
                      </div>
                      <div className="space-y-0.5 min-w-0">
                        <p className="text-sm font-medium text-slate-200">{label}</p>
                        <p className="text-xs text-slate-500 leading-relaxed">{description}</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={checked}
                      aria-label={`${checked ? t.removeFromPlan : t.includeInPlan} ${label}`}
                      onClick={() => handleToggle(key)}
                      className={`relative shrink-0 w-11 h-6 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-slate-800 ${
                        checked ? 'bg-blue-600' : 'bg-slate-600'
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                          checked ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>

                  {warning && (
                    <div className="mt-3 flex items-start gap-2 rounded-lg bg-amber-900/20 border border-amber-800/40 p-3">
                      <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
                      <p className="text-xs text-amber-200/90 leading-relaxed">{warning}</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {validationMsg && (
            <p className="text-xs text-amber-300 flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              {validationMsg}
            </p>
          )}

          <div className="h-4 text-xs">
            {saveStatus === 'saving' && (
              <span className="text-slate-400 flex items-center gap-1.5">
                <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" aria-hidden="true" />
                {t.saving}
              </span>
            )}
            {saveStatus === 'saved' && (
              <span className="text-green-400 flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                {t.saved}
              </span>
            )}
            {saveStatus === 'error' && (
              <span className="text-red-400 flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                {t.saveError}
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
