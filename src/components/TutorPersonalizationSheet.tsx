import { useState, useRef, useCallback } from 'react';
import { Loader2, Square, Play, X } from 'lucide-react';
import type { AIPreferences } from '../types';
import type { UseTutorPreferences } from '../hooks/useTutorPreferences';
import {
  REALTIME_VOICES,
  PERSONALITY_PRESETS,
  PACE_LABELS,
  ACCENT_LABELS,
  FORMALITY_LABELS,
  HUMOR_LABELS,
  ROAST_LABELS,
  INITIATIVE_LABELS,
  TIMING_LABELS,
  SCOPE_LABELS,
  LANGUAGE_LABELS,
  DETAIL_LABELS,
} from '../lib/tutorPreferences';
import { AVAILABLE_CONVERSATION_GOALS, DEFAULT_CONVERSATION_GOAL_MINUTES } from '../lib/conversationGoal';
import { getAuthHeader } from '../lib/apiAuth';

// Re-export hook type for convenience
export type { UseTutorPreferences };

type Tab = 'voz' | 'personalidade' | 'correcoes' | 'meta';

interface Props {
  hp: ReturnType<typeof import('../hooks/useTutorPreferences').useTutorPreferences>;
  sessionActive: boolean;
  onClose: () => void;
}

// ── Voice preview hook ────────────────────────────────────────────────────────

function useVoicePreview() {
  const audioRef    = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying]   = useState<string | null>(null);
  const [loading, setLoading]   = useState<string | null>(null);
  const [error, setError]       = useState<string | null>(null);

  const stop = useCallback(() => {
    audioRef.current?.pause();
    if (audioRef.current) audioRef.current.src = '';
    setPlaying(null);
  }, []);

  const preview = useCallback(async (voiceId: string, pace: AIPreferences['speechPace']) => {
    if (loading) return;
    if (playing === voiceId) { stop(); return; }
    stop();
    setLoading(voiceId);
    setError(null);
    try {
      const headers = await getAuthHeader();
      const resp = await fetch('/api/conversation/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ voice: voiceId, pace }),
      });
      if (!resp.ok) throw new Error('preview failed');
      const blob = await resp.blob();
      const url  = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => { setPlaying(null); URL.revokeObjectURL(url); };
      audio.onerror = () => { setPlaying(null); setError('Erro ao reproduzir.'); };
      await audio.play();
      setPlaying(voiceId);
    } catch {
      setError('Não foi possível carregar a amostra.');
    } finally {
      setLoading(null);
    }
  }, [loading, playing, stop]);

  return { playing, loading, error, preview, stop };
}

// ── Shared UI primitives ──────────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">{children}</h3>;
}

function OptionGroup<T extends string>({
  value, options, onChange, disabled,
}: {
  value: T;
  options: { id: T; label: string; description?: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-2">
      {options.map((opt) => (
        <button
          key={opt.id}
          onClick={() => onChange(opt.id)}
          disabled={disabled}
          className={`flex items-start gap-3 w-full text-left px-3 py-2.5 rounded-xl border transition-all focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            value === opt.id
              ? 'border-blue-500 bg-blue-600/15 text-slate-100'
              : 'border-slate-700 bg-slate-800/50 text-slate-300 hover:border-slate-600'
          } ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
        >
          <span className={`mt-0.5 w-3.5 h-3.5 rounded-full border-2 shrink-0 ${
            value === opt.id ? 'border-blue-400 bg-blue-400' : 'border-slate-600'
          }`} />
          <span>
            <span className="block text-sm font-medium">{opt.label}</span>
            {opt.description && (
              <span className="block text-xs text-slate-500 mt-0.5">{opt.description}</span>
            )}
          </span>
        </button>
      ))}
    </div>
  );
}

// ── Sections ──────────────────────────────────────────────────────────────────

function VozSection({
  prefs, update, sessionActive,
}: {
  prefs: AIPreferences;
  update: (u: Partial<AIPreferences>) => void;
  sessionActive: boolean;
}) {
  const vp = useVoicePreview();

  return (
    <div className="space-y-6">
      {sessionActive && (
        <div className="bg-amber-900/20 border border-amber-700/50 rounded-xl px-3 py-2 text-xs text-amber-300">
          Alterações de voz e ritmo serão aplicadas na próxima conversa.
        </div>
      )}

      {/* Voice */}
      <div>
        <SectionTitle>Voz</SectionTitle>
        {vp.error && <p className="text-xs text-red-400 mb-2">{vp.error}</p>}
        <div className="space-y-2">
          {REALTIME_VOICES.map((v) => {
            const isSelected = prefs.voice === v.id;
            const isPlaying  = vp.playing === v.id;
            const isLoading  = vp.loading === v.id;
            return (
              <div
                key={v.id}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-all cursor-pointer ${
                  isSelected
                    ? 'border-blue-500 bg-blue-600/15'
                    : 'border-slate-700 bg-slate-800/50 hover:border-slate-600'
                }`}
                onClick={() => update({ voice: v.id })}
                role="radio"
                aria-checked={isSelected}
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' || e.key === ' ' ? update({ voice: v.id }) : undefined}
              >
                <span className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 ${
                  isSelected ? 'border-blue-400 bg-blue-400' : 'border-slate-600'
                }`} />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-slate-200">{v.label}</span>
                  <span className="block text-xs text-slate-500">{v.description}</span>
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); vp.preview(v.id, prefs.speechPace); }}
                  className="shrink-0 px-2 py-1 rounded-lg text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-700 transition-colors focus:outline-none focus:ring-1 focus:ring-blue-500 min-w-[44px] min-h-[32px]"
                  aria-label={isPlaying ? `Parar amostra de ${v.label}` : `Ouvir ${v.label}`}
                >
                  {isLoading
                    ? <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" strokeWidth={2} aria-hidden="true" />
                    : isPlaying
                      ? <Square className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
                      : <Play className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
                  }
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Accent */}
      <div>
        <SectionTitle>Sotaque</SectionTitle>
        <OptionGroup
          value={prefs.accent}
          onChange={(v) => update({ accent: v })}
          options={(Object.entries(ACCENT_LABELS) as [AIPreferences['accent'], string][]).map(([id, label]) => ({ id, label }))}
        />
        <p className="text-xs text-slate-600 mt-2">O sotaque é aplicado por instruções de conversa, não por troca de voz.</p>
      </div>

      {/* Pace */}
      <div>
        <SectionTitle>Ritmo da conversa</SectionTitle>
        <OptionGroup
          value={prefs.speechPace}
          onChange={(v) => update({ speechPace: v })}
          options={(Object.entries(PACE_LABELS) as [AIPreferences['speechPace'], { label: string; description: string }][]).map(([id, { label, description }]) => ({ id, label, description }))}
        />
        <p className="text-xs text-slate-600 mt-2">Controlado por instruções de sessão. A amostra acima usa velocidade aproximada de reprodução.</p>
      </div>
    </div>
  );
}

function PersonalidadeSection({
  prefs, update,
}: {
  prefs: AIPreferences;
  update: (u: Partial<AIPreferences>) => void;
}) {
  const presetEntries = (Object.entries(PERSONALITY_PRESETS) as [
    Exclude<AIPreferences['personalityPreset'], 'custom'>,
    (typeof PERSONALITY_PRESETS)[keyof typeof PERSONALITY_PRESETS]
  ][]);

  function applyPreset(key: Exclude<AIPreferences['personalityPreset'], 'custom'>) {
    const def = PERSONALITY_PRESETS[key];
    update({
      personalityPreset: key,
      formality:         def.formality,
      humorLevel:        def.humorLevel,
      roastIntensity:    def.roastIntensity,
      profanityEnabled:  def.profanityEnabled,
      topicInitiative:   def.topicInitiative,
    });
  }

  return (
    <div className="space-y-6">
      {/* Presets */}
      <div>
        <SectionTitle>Preset</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          {presetEntries.map(([key, def]) => (
            <button
              key={key}
              onClick={() => applyPreset(key)}
              className={`flex flex-col items-start text-left px-3 py-3 rounded-xl border transition-all focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                prefs.personalityPreset === key
                  ? 'border-blue-500 bg-blue-600/15'
                  : 'border-slate-700 bg-slate-800/50 hover:border-slate-600'
              }`}
            >
              <span className="text-sm font-semibold text-slate-200">{def.label}</span>
              <span className="text-xs text-slate-500 mt-0.5 leading-relaxed">{def.description}</span>
            </button>
          ))}
          {prefs.personalityPreset === 'custom' && (
            <div className="border border-slate-600 bg-slate-800/30 rounded-xl px-3 py-3 col-span-2">
              <span className="text-xs text-slate-400">Personalizado — controles abaixo</span>
            </div>
          )}
        </div>
      </div>

      {/* Manual controls */}
      <div>
        <SectionTitle>Ajuste fino</SectionTitle>
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-slate-400 mb-2">Formalidade</label>
            <div className="flex gap-1.5 flex-wrap">
              {(Object.entries(FORMALITY_LABELS) as [AIPreferences['formality'], string][]).map(([id, label]) => (
                <button key={id} onClick={() => update({ formality: id })}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all focus:outline-none focus:ring-1 focus:ring-blue-500 ${
                    prefs.formality === id ? 'border-blue-500 bg-blue-600/20 text-blue-300' : 'border-slate-700 text-slate-400 hover:border-slate-500'
                  }`}
                >{label}</button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-2">Humor</label>
            <div className="flex gap-1.5">
              {(Object.entries(HUMOR_LABELS) as [AIPreferences['humorLevel'], string][]).map(([id, label]) => (
                <button key={id} onClick={() => update({ humorLevel: id })}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-medium border transition-all focus:outline-none focus:ring-1 focus:ring-blue-500 ${
                    prefs.humorLevel === id ? 'border-blue-500 bg-blue-600/20 text-blue-300' : 'border-slate-700 text-slate-400 hover:border-slate-500'
                  }`}
                >{label}</button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-2">Zoação</label>
            <div className="flex gap-1.5">
              {(Object.entries(ROAST_LABELS) as [AIPreferences['roastIntensity'], string][]).map(([id, label]) => (
                <button key={id} onClick={() => update({ roastIntensity: id })}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-medium border transition-all focus:outline-none focus:ring-1 focus:ring-blue-500 ${
                    prefs.roastIntensity === id ? 'border-blue-500 bg-blue-600/20 text-blue-300' : 'border-slate-700 text-slate-400 hover:border-slate-500'
                  }`}
                >{label}</button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-2">Palavrões</label>
            <div className="flex gap-1.5">
              {([false, true] as boolean[]).map((val) => (
                <button key={String(val)} onClick={() => update({ profanityEnabled: val })}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-medium border transition-all focus:outline-none focus:ring-1 focus:ring-blue-500 ${
                    prefs.profanityEnabled === val ? 'border-blue-500 bg-blue-600/20 text-blue-300' : 'border-slate-700 text-slate-400 hover:border-slate-500'
                  }`}
                >{val ? 'Permitidos' : 'Desabilitados'}</button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-2">Iniciativa de assuntos</label>
            <div className="flex gap-1.5">
              {(Object.entries(INITIATIVE_LABELS) as [AIPreferences['topicInitiative'], string][]).map(([id, label]) => (
                <button key={id} onClick={() => update({ topicInitiative: id })}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-medium border transition-all focus:outline-none focus:ring-1 focus:ring-blue-500 ${
                    prefs.topicInitiative === id ? 'border-blue-500 bg-blue-600/20 text-blue-300' : 'border-slate-700 text-slate-400 hover:border-slate-500'
                  }`}
                >{label}</button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function CorrecoesSection({
  prefs, update,
}: {
  prefs: AIPreferences;
  update: (u: Partial<AIPreferences>) => void;
}) {
  return (
    <div className="space-y-6">
      <div>
        <SectionTitle>Quando corrigir</SectionTitle>
        <OptionGroup
          value={prefs.correctionTiming}
          onChange={(v) => update({ correctionTiming: v })}
          options={(Object.entries(TIMING_LABELS) as [AIPreferences['correctionTiming'], { label: string; description: string }][]).map(([id, { label, description }]) => ({ id, label, description }))}
        />
      </div>

      <div>
        <SectionTitle>O que corrigir</SectionTitle>
        <OptionGroup
          value={prefs.correctionScope}
          onChange={(v) => update({ correctionScope: v })}
          options={(Object.entries(SCOPE_LABELS) as [AIPreferences['correctionScope'], { label: string; description: string }][]).map(([id, { label, description }]) => ({ id, label, description }))}
        />
      </div>

      <div>
        <SectionTitle>Idioma da explicação</SectionTitle>
        <div className="flex gap-2">
          {(Object.entries(LANGUAGE_LABELS) as [AIPreferences['correctionLanguage'], string][]).map(([id, label]) => (
            <button key={id} onClick={() => update({ correctionLanguage: id })}
              className={`flex-1 py-2.5 rounded-xl text-sm font-medium border transition-all focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                prefs.correctionLanguage === id ? 'border-blue-500 bg-blue-600/20 text-blue-300' : 'border-slate-700 text-slate-400 hover:border-slate-600'
              }`}
            >{label}</button>
          ))}
        </div>
      </div>

      <div>
        <SectionTitle>Nível de detalhe</SectionTitle>
        <OptionGroup
          value={prefs.correctionDetail}
          onChange={(v) => update({ correctionDetail: v })}
          options={(Object.entries(DETAIL_LABELS) as [AIPreferences['correctionDetail'], { label: string; description: string }][]).map(([id, { label, description }]) => ({ id, label, description }))}
        />
      </div>
    </div>
  );
}

// ── Meta section ──────────────────────────────────────────────────────────────

function MetaSection({
  prefs, update,
}: {
  prefs: AIPreferences;
  update: (u: Partial<AIPreferences>) => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <SectionTitle>Meta diária de conversação</SectionTitle>
        <p className="text-xs text-slate-500 mb-3">Quanto tempo você deseja conversar com a IA por dia?</p>
        <OptionGroup
          value={String(prefs.dailyConversationGoalMinutes)}
          options={AVAILABLE_CONVERSATION_GOALS.map((g) => ({
            id: String(g),
            label: `${g} minutos`,
            description: g === DEFAULT_CONVERSATION_GOAL_MINUTES ? 'Padrão recomendado' : undefined,
          }))}
          onChange={(v) => update({ dailyConversationGoalMinutes: Number(v) })}
        />
        <p className="text-xs text-slate-600 mt-3">
          Máximo de 30 minutos. A meta é acumulada entre sessões do mesmo dia.
        </p>
      </div>
    </div>
  );
}

// ── Main sheet ────────────────────────────────────────────────────────────────

export default function TutorPersonalizationSheet({ hp, sessionActive, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('voz');
  const TABS: { id: Tab; label: string }[] = [
    { id: 'voz',          label: 'Voz' },
    { id: 'personalidade', label: 'Personalidade' },
    { id: 'correcoes',    label: 'Correções' },
    { id: 'meta',         label: 'Meta' },
  ];

  async function handleSave() {
    await hp.save();
    if (hp.saveResult !== 'error') {
      setTimeout(onClose, 600);
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 z-40 sm:flex sm:items-center sm:justify-center"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sheet / modal */}
      <div
        className="fixed inset-x-0 bottom-0 z-50 bg-slate-900 border-t border-slate-700 rounded-t-2xl max-h-[90dvh] flex flex-col sm:inset-auto sm:bottom-auto sm:left-1/2 sm:-translate-x-1/2 sm:top-1/2 sm:-translate-y-1/2 sm:w-full sm:max-w-lg sm:rounded-2xl sm:border sm:border-slate-700"
        role="dialog"
        aria-modal="true"
        aria-label="Personalizar tutor"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 pt-4 pb-2 shrink-0">
          <h2 className="text-base font-semibold text-slate-100">Personalizar tutor</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
            aria-label="Fechar"
          ><X className="w-4 h-4 shrink-0" strokeWidth={2} aria-hidden="true" /></button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-700 px-4 shrink-0">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`py-2.5 px-1 mr-4 text-sm font-medium border-b-2 -mb-px transition-colors focus:outline-none ${
                tab === t.id
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >{t.label}</button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {tab === 'voz'          && <VozSection          prefs={hp.prefs} update={hp.updateDraft} sessionActive={sessionActive} />}
          {tab === 'personalidade' && <PersonalidadeSection prefs={hp.prefs} update={hp.updateDraft} />}
          {tab === 'correcoes'    && <CorrecoesSection     prefs={hp.prefs} update={hp.updateDraft} />}
          {tab === 'meta'         && <MetaSection          prefs={hp.prefs} update={hp.updateDraft} />}
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-slate-700 px-4 py-3 space-y-2">
          {hp.saveResult === 'success' && (
            <p className="text-xs text-green-400 text-center">Configurações salvas!</p>
          )}
          {hp.saveResult === 'error' && (
            <p className="text-xs text-red-400 text-center">Erro ao salvar. Tente novamente.</p>
          )}

          <div className="flex gap-2">
            <button
              onClick={hp.resetToDefault}
              className="px-3 py-2 rounded-xl border border-slate-700 text-xs text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors focus:outline-none focus:ring-1 focus:ring-blue-500"
            >Restaurar padrão</button>

            <button
              onClick={handleSave}
              disabled={hp.saving || !hp.isDirty}
              className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-slate-900 ${
                hp.isDirty && !hp.saving
                  ? 'bg-blue-600 hover:bg-blue-500 text-white'
                  : 'bg-slate-700 text-slate-500 cursor-not-allowed'
              }`}
            >
              {hp.saving ? 'Salvando…' : 'Salvar alterações'}
            </button>
          </div>

          {hp.isDirty && !hp.saving && (
            <p className="text-xs text-amber-400 text-center">Alterações não salvas</p>
          )}
        </div>
      </div>
    </>
  );
}
