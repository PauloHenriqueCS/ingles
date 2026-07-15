import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Volume2, Play, Loader2, Check, AlertCircle } from 'lucide-react';
import {
  AZURE_VOICES,
  AUDIO_PREVIEW_TEXT,
  AudioSettings,
  DEFAULT_AUDIO_SETTINGS,
  fetchAudioSettings,
  saveAudioSettings,
} from '../lib/audioSettings';
import { getAuthHeader } from '../lib/apiAuth';

type PreviewStatus = 'idle' | 'loading' | 'playing' | 'done' | 'error';
type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface Props {
  onBack: () => void;
}

export default function AudioSettingsView({ onBack }: Props) {
  const [settings, setSettings] = useState<AudioSettings>(DEFAULT_AUDIO_SETTINGS);
  const [loadState, setLoadState] = useState<'loading' | 'done' | 'error'>('loading');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');

  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>('idle');
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewBlobRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    fetchAudioSettings()
      .then((s) => { if (mountedRef.current) { setSettings(s); setLoadState('done'); } })
      .catch(() => { if (mountedRef.current) setLoadState('error'); });
    return () => {
      mountedRef.current = false;
      stopPreview();
    };
  }, []);

  function stopPreview() {
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current.onended = null;
      previewAudioRef.current.onerror = null;
      previewAudioRef.current = null;
    }
    if (previewBlobRef.current) {
      URL.revokeObjectURL(previewBlobRef.current);
      previewBlobRef.current = null;
    }
  }

  async function handlePreview(voiceId: string, azureVoiceName: string) {
    if (previewingId === voiceId && previewStatus === 'loading') return;
    stopPreview();
    setPreviewingId(voiceId);
    setPreviewStatus('loading');
    try {
      const authHeader = await getAuthHeader();
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ text: AUDIO_PREVIEW_TEXT, voice: azureVoiceName }),
      });
      if (!res.ok) throw new Error('tts error');
      const blob = await res.blob();
      if (!blob.size) throw new Error('empty');
      const url = URL.createObjectURL(blob);
      previewBlobRef.current = url;
      const audio = new Audio(url);
      previewAudioRef.current = audio;
      audio.onended = () => { if (mountedRef.current) setPreviewStatus('done'); };
      audio.onerror = () => { if (mountedRef.current) setPreviewStatus('error'); };
      await audio.play();
      if (mountedRef.current) setPreviewStatus('playing');
    } catch {
      if (mountedRef.current) setPreviewStatus('error');
    }
  }

  async function handleSave() {
    setSaveStatus('saving');
    try {
      await saveAudioSettings(settings);
      setSaveStatus('saved');
      setTimeout(() => { if (mountedRef.current) setSaveStatus('idle'); }, 2000);
    } catch {
      setSaveStatus('error');
    }
  }

  const ACCENTS: { value: AudioSettings['accent']; label: string; note?: string }[] = [
    { value: 'american',   label: 'Americano' },
    { value: 'british',    label: 'Britânico',   note: 'em breve' },
    { value: 'australian', label: 'Australiano', note: 'em breve' },
  ];

  const SPEEDS: AudioSettings['playbackRate'][] = [0.75, 0.9, 1];

  if (loadState === 'loading') {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col">
        <header className="sticky top-0 bg-slate-800 border-b border-slate-700 px-4 py-3 z-10 flex items-center gap-3">
          <button onClick={onBack} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors">
            <ArrowLeft className="w-4 h-4 shrink-0" />
          </button>
          <h1 className="text-base font-semibold text-slate-100">Configurações de áudio</h1>
        </header>
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-6 h-6 text-slate-500 animate-spin" />
        </div>
      </div>
    );
  }

  if (loadState === 'error') {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col">
        <header className="sticky top-0 bg-slate-800 border-b border-slate-700 px-4 py-3 z-10 flex items-center gap-3">
          <button onClick={onBack} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors">
            <ArrowLeft className="w-4 h-4 shrink-0" />
          </button>
          <h1 className="text-base font-semibold text-slate-100">Configurações de áudio</h1>
        </header>
        <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center">
          <AlertCircle className="w-8 h-8 text-red-400 shrink-0" />
          <p className="text-slate-300 text-sm">Não foi possível carregar as configurações.</p>
          <button
            onClick={() => { setLoadState('loading'); fetchAudioSettings().then(s => { setSettings(s); setLoadState('done'); }).catch(() => setLoadState('error')); }}
            className="text-xs text-slate-400 hover:text-slate-200 transition-colors underline"
          >
            Tentar novamente
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      <header className="sticky top-0 bg-slate-800 border-b border-slate-700 px-4 py-3 z-10 flex items-center gap-3">
        <button
          onClick={onBack}
          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors"
          aria-label="Voltar"
        >
          <ArrowLeft className="w-4 h-4 shrink-0" />
        </button>
        <h1 className="text-base font-semibold text-slate-100">Configurações de áudio</h1>
      </header>

      <div className="flex-1 overflow-auto p-4 max-w-lg mx-auto w-full space-y-5 pb-32">

        {/* Voice */}
        <section className="bg-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Volume2 className="w-4 h-4 text-slate-400 shrink-0" />
            <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Voz padrão</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {AZURE_VOICES.map((v) => {
              const isSelected = settings.voice === v.azureVoiceName;
              const isPreviewing = previewingId === v.id;
              return (
                <div
                  key={v.id}
                  onClick={() => setSettings((s) => ({ ...s, voice: v.azureVoiceName }))}
                  className={`relative rounded-xl p-3 space-y-2 cursor-pointer border transition-all ${
                    isSelected
                      ? 'border-blue-500 bg-blue-900/20'
                      : 'border-slate-700 bg-slate-700/40 hover:border-slate-600'
                  }`}
                >
                  {isSelected && (
                    <div className="absolute top-2 right-2 w-4 h-4 rounded-full bg-blue-500 flex items-center justify-center">
                      <Check className="w-2.5 h-2.5 text-white" strokeWidth={3} />
                    </div>
                  )}
                  <div>
                    <p className="text-sm font-medium text-slate-100">{v.label}</p>
                    <p className="text-xs text-slate-500">{v.gender === 'female' ? 'Feminino' : 'Masculino'}</p>
                  </div>
                  {v.badge && (
                    <span className="inline-block text-[10px] text-blue-300 bg-blue-900/40 border border-blue-800/40 rounded px-1.5 py-0.5 leading-none">
                      {v.badge}
                    </span>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); handlePreview(v.id, v.azureVoiceName); }}
                    disabled={isPreviewing && previewStatus === 'loading'}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-600 hover:bg-slate-500 disabled:opacity-50 text-slate-300 text-xs transition-colors"
                    aria-label={`Ouvir voz ${v.label}`}
                  >
                    {isPreviewing && previewStatus === 'loading' ? (
                      <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                    ) : (
                      <Play className="w-3 h-3 shrink-0" />
                    )}
                    Ouvir
                  </button>
                </div>
              );
            })}
          </div>
          {previewingId && previewStatus === 'error' && (
            <p className="text-xs text-red-400">Não foi possível reproduzir o áudio de prévia.</p>
          )}
        </section>

        {/* Accent */}
        <section className="bg-slate-800 rounded-xl p-5 space-y-3">
          <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Sotaque</p>
          <div className="flex gap-2 flex-wrap">
            {ACCENTS.map(({ value, label, note }) => {
              const isSelected = settings.accent === value;
              const disabled = !!note;
              return (
                <button
                  key={value}
                  onClick={() => { if (!disabled) setSettings((s) => ({ ...s, accent: value })); }}
                  disabled={disabled}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors
                    ${isSelected && !disabled
                      ? 'bg-blue-600 text-white'
                      : disabled
                      ? 'bg-slate-700/50 text-slate-600 cursor-not-allowed'
                      : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                    }`}
                >
                  {label}
                  {note && <span className="text-xs text-slate-600 font-normal">({note})</span>}
                </button>
              );
            })}
          </div>
        </section>

        {/* Speed */}
        <section className="bg-slate-800 rounded-xl p-5 space-y-3">
          <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Velocidade padrão</p>
          <div className="flex gap-2">
            {SPEEDS.map((s) => (
              <button
                key={s}
                onClick={() => setSettings((prev) => ({ ...prev, playbackRate: s }))}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  settings.playbackRate === s
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                }`}
              >
                {s}×
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-500">Velocidade inicial ao ouvir a Versão 2.</p>
        </section>

        {/* Shadowing */}
        <section className="bg-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <p className="text-sm font-medium text-slate-200">Shadowing automático</p>
              <p className="text-xs text-slate-500">Reproduzir o áudio da Versão 2 automaticamente ao abrir a seção de reescrita.</p>
            </div>
            <button
              role="switch"
              aria-checked={settings.autoPlayShadowing}
              onClick={() => setSettings((s) => ({ ...s, autoPlayShadowing: !s.autoPlayShadowing }))}
              className={`relative shrink-0 w-11 h-6 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-slate-800 ${
                settings.autoPlayShadowing ? 'bg-blue-600' : 'bg-slate-600'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                  settings.autoPlayShadowing ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        </section>

        {/* Translation */}
        <section className="bg-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <p className="text-sm font-medium text-slate-200">Mostrar tradução</p>
              <p className="text-xs text-slate-500">Exibir a tradução em português ao lado do texto original nas correções.</p>
            </div>
            <button
              role="switch"
              aria-checked={settings.showTranslation}
              onClick={() => setSettings((s) => ({ ...s, showTranslation: !s.showTranslation }))}
              className={`relative shrink-0 w-11 h-6 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-slate-800 ${
                settings.showTranslation ? 'bg-blue-600' : 'bg-slate-600'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                  settings.showTranslation ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        </section>

      </div>

      {/* Save bar */}
      <div className="fixed bottom-0 left-0 right-0 bg-slate-900/95 border-t border-slate-700 p-4">
        <div className="max-w-lg mx-auto flex items-center gap-3">
          {saveStatus === 'error' && (
            <p className="text-xs text-red-400 flex-1">Não foi possível salvar. Tente novamente.</p>
          )}
          {saveStatus === 'saved' && (
            <p className="text-xs text-green-400 flex-1 flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5 shrink-0" />
              Configurações salvas
            </p>
          )}
          {(saveStatus === 'idle' || saveStatus === 'saving') && <div className="flex-1" />}
          <button
            onClick={handleSave}
            disabled={saveStatus === 'saving'}
            className="px-6 py-2.5 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            {saveStatus === 'saving' && <Loader2 className="w-4 h-4 animate-spin shrink-0" />}
            {saveStatus === 'saving' ? 'Salvando...' : 'Salvar'}
          </button>
        </div>
      </div>
    </div>
  );
}
