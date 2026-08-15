import { useState, useEffect } from 'react';
import { PenSquare, Headphones, AudioLines, MessagesSquare, AlertCircle, Check, Loader2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  getCurriculumPreferences,
  updateCurriculumPreferences,
  type CurriculumModalities,
  type ModalityKey,
} from '../lib/curriculumApi';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface ModalityDef {
  key: ModalityKey;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Extra emphasis text always shown under the description. */
  warning?: string;
}

const MODALITIES: ModalityDef[] = [
  {
    key: 'writing',
    label: 'Escrita',
    description: 'Escrever um texto e revisá-lo com a IA fará parte das práticas necessárias para avançar em cada etapa.',
    icon: PenSquare,
  },
  {
    key: 'listening',
    label: 'Listening',
    description: 'Ouvir uma história e responder às perguntas fará parte das práticas necessárias para avançar em cada etapa.',
    icon: Headphones,
  },
  {
    key: 'pronunciation',
    label: 'Pronúncia',
    description: 'Treinar a pronúncia das palavras fará parte das práticas necessárias para avançar em cada etapa.',
    icon: AudioLines,
  },
  {
    key: 'conversation',
    label: 'Conversação IA',
    description: 'Converse com o tutor virtual para praticar inglês falado.',
    icon: MessagesSquare,
    warning:
      'Ao incluir Conversação IA no seu plano de ensino, uma conversa guiada fará parte das práticas necessárias para avançar em cada etapa e utilizará seus minutos disponíveis.',
  },
];

function countSelected(m: CurriculumModalities): number {
  return Object.values(m).filter(Boolean).length;
}

export default function CurriculumModalityPreferences() {
  const [modalities, setModalities] = useState<CurriculumModalities | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'done' | 'error'>('loading');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [validationMsg, setValidationMsg] = useState<string | null>(null);

  function load() {
    setLoadState('loading');
    getCurriculumPreferences()
      .then((prefs) => {
        setModalities(prefs.modalities);
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
      setValidationMsg('Selecione ao menos uma prática para o seu plano de ensino.');
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
        <h2 className="text-sm font-semibold text-slate-100">Práticas do seu plano</h2>
        <p className="text-xs text-slate-400 leading-relaxed">
          O menu é a regra: cada prática que você selecionar aqui passa a ser
          <span className="text-slate-300 font-medium"> obrigatória para avançar em cada etapa</span> do
          seu plano de ensino.
        </p>
      </div>

      {loadState === 'loading' && (
        <div className="flex items-center gap-2 py-4 text-slate-400 text-sm">
          <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" />
          Carregando preferências…
        </div>
      )}

      {loadState === 'error' && (
        <div className="bg-red-900/30 border border-red-800 rounded-lg p-4 text-center space-y-2">
          <p className="text-red-300 text-sm">Não foi possível carregar suas preferências.</p>
          <button onClick={load} className="text-xs text-slate-400 hover:text-slate-200 transition-colors">
            Tentar novamente
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
                      aria-label={`${checked ? 'Remover' : 'Incluir'} ${label} no plano`}
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
                Salvando…
              </span>
            )}
            {saveStatus === 'saved' && (
              <span className="text-green-400 flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                Preferências salvas.
              </span>
            )}
            {saveStatus === 'error' && (
              <span className="text-red-400 flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                Não foi possível salvar. Tente novamente.
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
