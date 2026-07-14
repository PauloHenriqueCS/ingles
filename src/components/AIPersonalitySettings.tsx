import { useState } from 'react';
import { AVAILABLE_VOICES } from '../lib/promptBuilder';
import type { AIPreferences } from '../types';

interface Props {
  prefs: AIPreferences;
  onSave: (updates: Partial<AIPreferences>) => Promise<void>;
  sessionActive: boolean;
}

export default function AIPersonalitySettings({ prefs, onSave, sessionActive }: Props) {
  const [saving, setSaving] = useState(false);

  async function handleChange<K extends keyof AIPreferences>(key: K, value: AIPreferences[K]) {
    setSaving(true);
    await onSave({ [key]: value });
    setSaving(false);
  }

  return (
    <div className="bg-slate-800 rounded-xl p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-200">Configurações do tutor</h3>
        {saving && <span className="text-xs text-slate-500">Salvando...</span>}
      </div>

      <div className="space-y-3">
        <div>
          <label className="block text-xs text-slate-400 mb-1.5">Nome do tutor</label>
          <input
            type="text"
            value={prefs.teacherName}
            onChange={(e) => handleChange('teacherName', e.target.value)}
            className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
            maxLength={30}
          />
        </div>

        <div>
          <label className="block text-xs text-slate-400 mb-1.5">Personalidade</label>
          <select
            value={prefs.personality}
            onChange={(e) =>
              handleChange('personality', e.target.value as AIPreferences['personality'])
            }
            className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="friendly">Amigável e encorajador</option>
            <option value="professional">Profissional e focado</option>
            <option value="strict">Rigoroso e detalhista</option>
          </select>
        </div>

        <div>
          <label className="block text-xs text-slate-400 mb-1.5">Estilo de correção</label>
          <select
            value={prefs.correctionStyle}
            onChange={(e) =>
              handleChange('correctionStyle', e.target.value as AIPreferences['correctionStyle'])
            }
            className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="gentle">Sutil e gentil</option>
            <option value="direct">Direto e explícito</option>
          </select>
        </div>

        <div>
          <label className="block text-xs text-slate-400 mb-1.5">
            Voz
            {sessionActive && (
              <span className="ml-2 text-amber-400">(reinicie a sessão para aplicar)</span>
            )}
          </label>
          <select
            value={prefs.voice}
            onChange={(e) => handleChange('voice', e.target.value)}
            className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {AVAILABLE_VOICES.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
