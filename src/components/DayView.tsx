import { useState, useEffect } from 'react';
import { DayEntry, Difficulty, Status } from '../types';
import { getScheduleForDate } from '../data/calendar2026';
import { countWords } from '../utils/wordCount';

interface Props {
  date: string;
  entry: DayEntry | null;
  onSave: (patch: Partial<DayEntry> & { date: string }) => Promise<void>;
  onBack: () => void;
}

const STATUS_OPTS: { value: Status; label: string; cls: string }[] = [
  { value: 'nao-iniciado', label: 'Não iniciado', cls: 'bg-slate-700 text-slate-300' },
  { value: 'escrito', label: 'Escrito', cls: 'bg-blue-700 text-blue-100' },
  { value: 'corrigido', label: 'Corrigido', cls: 'bg-amber-700 text-amber-100' },
  { value: 'revisado', label: 'Revisado', cls: 'bg-green-700 text-green-100' },
];

const DIFF_OPTS: { value: Difficulty; label: string; cls: string }[] = [
  { value: 'facil', label: 'Fácil', cls: 'bg-green-700 text-green-100' },
  { value: 'medio', label: 'Médio', cls: 'bg-amber-700 text-amber-100' },
  { value: 'dificil', label: 'Difícil', cls: 'bg-red-700 text-red-100' },
];

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export default function DayView({ date, entry, onSave, onBack }: Props) {
  const schedule = getScheduleForDate(date);

  const [title, setTitle] = useState(entry?.title ?? '');
  const [originalText, setOriginalText] = useState(entry?.originalText ?? '');
  const [correctedText, setCorrectedText] = useState(entry?.correctedText ?? '');
  const [observations, setObservations] = useState(entry?.observations ?? '');
  const [mainErrors, setMainErrors] = useState(entry?.mainErrors ?? '');
  const [difficulty, setDifficulty] = useState<Difficulty>(entry?.difficulty ?? null);
  const [status, setStatus] = useState<Status>(entry?.status ?? 'nao-iniciado');
  const [saveState, setSaveState] = useState<SaveState>('idle');

  useEffect(() => {
    setTitle(entry?.title ?? '');
    setOriginalText(entry?.originalText ?? '');
    setCorrectedText(entry?.correctedText ?? '');
    setObservations(entry?.observations ?? '');
    setMainErrors(entry?.mainErrors ?? '');
    setDifficulty(entry?.difficulty ?? null);
    setStatus(entry?.status ?? 'nao-iniciado');
    setSaveState('idle');
  }, [date, entry]);

  async function handleSave(overrideStatus?: Status) {
    const finalStatus: Status =
      overrideStatus ??
      (status === 'nao-iniciado' && originalText.trim().length > 0 ? 'escrito' : status);

    setSaveState('saving');
    try {
      await onSave({ date, title, originalText, correctedText, observations, mainErrors, difficulty, status: finalStatus });
      setStatus(finalStatus);
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 2000);
    } catch {
      setSaveState('error');
      setTimeout(() => setSaveState('idle'), 3000);
    }
  }

  const dateObj = new Date(date + 'T12:00:00');
  const dateLabel = dateObj.toLocaleDateString('pt-BR', {
    weekday: 'long', day: 'numeric', month: 'long',
  });

  const words = countWords(originalText);

  const saveLabel =
    saveState === 'saving' ? 'Salvando...' :
    saveState === 'saved' ? '✓ Salvo!' :
    saveState === 'error' ? 'Erro ao salvar' :
    'Salvar';

  const saveCls =
    saveState === 'saving' ? 'bg-slate-600 text-slate-300' :
    saveState === 'saved' ? 'bg-green-600 text-white' :
    saveState === 'error' ? 'bg-red-700 text-white' :
    'bg-blue-600 hover:bg-blue-500 text-white';

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      <div className="sticky top-0 bg-slate-800 border-b border-slate-700 px-4 py-3 flex items-center gap-3 z-10">
        <button onClick={onBack} className="text-slate-400 hover:text-slate-100 text-lg">←</button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-100 capitalize truncate">{dateLabel}</p>
          <p className="text-xs text-slate-400 truncate">{schedule?.theme ?? '—'}</p>
        </div>
        <StatusBadgePill status={status} />
      </div>

      <div className="flex-1 overflow-auto p-4 max-w-lg mx-auto w-full space-y-5 pb-24">
        {schedule && !schedule.isWeekend && (
          <div className="bg-slate-800 rounded-lg p-4 space-y-1">
            <InfoRow label="Tema" value={schedule.theme} />
            <InfoRow label="Tempo verbal" value={schedule.verbTense} />
            <InfoRow label="Objetivo" value={schedule.grammarObjective} />
          </div>
        )}

        {schedule?.isWeekend && (
          <div className="bg-slate-800 rounded-lg p-4 text-center text-slate-400">
            <p className="text-2xl mb-2">{schedule.weekendActivity === 'descanso' ? '😴' : '📖'}</p>
            <p className="font-medium text-slate-300">{schedule.theme}</p>
            <p className="text-sm mt-1">{schedule.grammarObjective}</p>
          </div>
        )}

        {/* Title */}
        <div>
          <label className="text-xs text-slate-400 mb-2 block">Título do texto</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Ex: My Morning Routine"
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-slate-100 placeholder-slate-600 text-sm focus:outline-none focus:border-blue-500"
          />
        </div>

        {/* Status selector */}
        <div>
          <label className="text-xs text-slate-400 mb-2 block">Status</label>
          <div className="flex gap-2 flex-wrap">
            {STATUS_OPTS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setStatus(opt.value)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-opacity ${opt.cls} ${
                  status === opt.value ? 'opacity-100 ring-2 ring-white/30' : 'opacity-40'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Difficulty selector */}
        <div>
          <label className="text-xs text-slate-400 mb-2 block">Dificuldade</label>
          <div className="flex gap-2">
            {DIFF_OPTS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setDifficulty(difficulty === opt.value ? null : opt.value)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-opacity ${opt.cls} ${
                  difficulty === opt.value ? 'opacity-100 ring-2 ring-white/30' : 'opacity-40'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Original text */}
        <div>
          <div className="flex justify-between mb-2">
            <label className="text-xs text-slate-400">Texto original</label>
            <span className="text-xs text-slate-500">{words} palavras</span>
          </div>
          <textarea
            value={originalText}
            onChange={(e) => setOriginalText(e.target.value)}
            placeholder="Escreva seu texto em inglês aqui..."
            className="w-full bg-slate-800 border border-slate-700 rounded-lg p-3 text-slate-100 placeholder-slate-600 text-sm focus:outline-none focus:border-blue-500 min-h-[160px]"
          />
        </div>

        {/* Corrected text */}
        <div>
          <label className="text-xs text-slate-400 mb-2 block">Versão corrigida</label>
          <textarea
            value={correctedText}
            onChange={(e) => setCorrectedText(e.target.value)}
            placeholder="Cole aqui a versão corrigida..."
            className="w-full bg-slate-800 border border-slate-700 rounded-lg p-3 text-slate-100 placeholder-slate-600 text-sm focus:outline-none focus:border-amber-500 min-h-[120px]"
          />
        </div>

        {/* Main errors */}
        <div>
          <label className="text-xs text-slate-400 mb-2 block">Principais erros cometidos</label>
          <textarea
            value={mainErrors}
            onChange={(e) => setMainErrors(e.target.value)}
            placeholder="Ex: uso errado de preposição, tempo verbal..."
            className="w-full bg-slate-800 border border-slate-700 rounded-lg p-3 text-slate-100 placeholder-slate-600 text-sm focus:outline-none focus:border-red-500 min-h-[80px]"
          />
        </div>

        {/* Observations */}
        <div>
          <label className="text-xs text-slate-400 mb-2 block">Observações / anotações</label>
          <textarea
            value={observations}
            onChange={(e) => setObservations(e.target.value)}
            placeholder="Anotações livres, vocabulário novo, dúvidas..."
            className="w-full bg-slate-800 border border-slate-700 rounded-lg p-3 text-slate-100 placeholder-slate-600 text-sm focus:outline-none focus:border-slate-500 min-h-[80px]"
          />
        </div>

        {/* Quick action buttons */}
        <div className="flex gap-2">
          <button
            onClick={() => handleSave('corrigido')}
            className="flex-1 py-2 rounded-lg bg-amber-700/50 text-amber-200 text-sm font-medium hover:bg-amber-700 transition-colors"
          >
            Marcar corrigido
          </button>
          <button
            onClick={() => handleSave('revisado')}
            className="flex-1 py-2 rounded-lg bg-green-700/50 text-green-200 text-sm font-medium hover:bg-green-700 transition-colors"
          >
            Marcar revisado
          </button>
        </div>
      </div>

      <div className="fixed bottom-0 left-0 right-0 p-4 bg-slate-900 border-t border-slate-700">
        <button
          onClick={() => handleSave()}
          disabled={saveState === 'saving'}
          className={`w-full py-3 rounded-xl font-semibold text-sm transition-all ${saveCls}`}
        >
          {saveLabel}
        </button>
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-sm">
      <span className="text-slate-500 shrink-0 w-24">{label}:</span>
      <span className="text-slate-200">{value}</span>
    </div>
  );
}

function StatusBadgePill({ status }: { status: Status }) {
  const map: Record<Status, string> = {
    'nao-iniciado': 'bg-slate-700 text-slate-400',
    'escrito': 'bg-blue-700 text-blue-200',
    'corrigido': 'bg-amber-700 text-amber-200',
    'revisado': 'bg-green-700 text-green-200',
  };
  const labels: Record<Status, string> = {
    'nao-iniciado': 'Não iniciado',
    'escrito': 'Escrito',
    'corrigido': 'Corrigido',
    'revisado': 'Revisado',
  };
  return (
    <span className={`px-2 py-1 rounded-md text-xs font-medium ${map[status]}`}>
      {labels[status]}
    </span>
  );
}
