import { useState } from 'react';
import { EntriesStore, Status, Difficulty } from '../types';
import { getScheduleForDate, ALL_VERB_TENSES, MONTH_NAMES_PT } from '../data/calendar2026';

interface Props {
  entries: EntriesStore;
  onOpenDay: (date: string) => void;
}

type FilterStatus = Status | 'todos';
type FilterDiff = Difficulty | 'todos';

export default function FilterView({ entries, onOpenDay }: Props) {
  const [filterVerbTense, setFilterVerbTense] = useState<string>('todos');
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('todos');
  const [filterDiff, setFilterDiff] = useState<FilterDiff>('todos');
  const [filterNotReviewed, setFilterNotReviewed] = useState(false);

  const allDates = Object.keys(entries).sort().reverse();

  const filtered = allDates.filter((date) => {
    const entry = entries[date];
    if (!entry.originalText.trim()) return false;

    const schedule = getScheduleForDate(date);

    if (filterVerbTense !== 'todos' && schedule?.verbTense !== filterVerbTense) return false;
    if (filterStatus !== 'todos' && entry.status !== filterStatus) return false;
    if (filterDiff !== 'todos' && entry.difficulty !== filterDiff) return false;
    if (filterNotReviewed && entry.status === 'revisado') return false;

    return true;
  });

  return (
    <div className="p-4 max-w-lg mx-auto">
      <h2 className="font-semibold text-slate-100 mb-4">Filtros</h2>

      {/* Filters */}
      <div className="space-y-4 mb-6">
        {/* Verb tense */}
        <div>
          <label className="text-xs text-slate-400 mb-2 block">Tempo verbal</label>
          <select
            value={filterVerbTense}
            onChange={(e) => setFilterVerbTense(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 text-sm focus:outline-none focus:border-blue-500"
          >
            <option value="todos">Todos</option>
            {ALL_VERB_TENSES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>

        {/* Status */}
        <div>
          <label className="text-xs text-slate-400 mb-2 block">Status</label>
          <div className="flex gap-2 flex-wrap">
            {(['todos', 'nao-iniciado', 'escrito', 'corrigido', 'revisado'] as FilterStatus[]).map((s) => (
              <button
                key={s}
                onClick={() => setFilterStatus(s)}
                className={`px-3 py-1.5 rounded-md text-xs transition-colors ${
                  filterStatus === s
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                }`}
              >
                {s === 'todos' ? 'Todos' : s === 'nao-iniciado' ? 'Não iniciado' : s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Difficulty */}
        <div>
          <label className="text-xs text-slate-400 mb-2 block">Dificuldade</label>
          <div className="flex gap-2 flex-wrap">
            {(['todos', 'facil', 'medio', 'dificil'] as FilterDiff[]).map((d) => (
              <button
                key={String(d)}
                onClick={() => setFilterDiff(d)}
                className={`px-3 py-1.5 rounded-md text-xs transition-colors ${
                  filterDiff === d
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                }`}
              >
                {d === 'todos' ? 'Todos' : d === 'facil' ? 'Fácil' : d === 'medio' ? 'Médio' : 'Difícil'}
              </button>
            ))}
          </div>
        </div>

        {/* Not reviewed toggle */}
        <label className="flex items-center gap-3 cursor-pointer">
          <div
            onClick={() => setFilterNotReviewed(!filterNotReviewed)}
            className={`w-10 h-6 rounded-full transition-colors relative ${
              filterNotReviewed ? 'bg-blue-600' : 'bg-slate-700'
            }`}
          >
            <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${
              filterNotReviewed ? 'translate-x-5' : 'translate-x-1'
            }`} />
          </div>
          <span className="text-sm text-slate-300">Somente não revisados</span>
        </label>
      </div>

      {/* Results */}
      <div className="space-y-2">
        <p className="text-xs text-slate-500 mb-3">{filtered.length} resultado{filtered.length !== 1 ? 's' : ''}</p>
        {filtered.map((date) => {
          const entry = entries[date];
          const schedule = getScheduleForDate(date);
          const dateObj = new Date(date + 'T12:00:00');

          return (
            <button
              key={date}
              onClick={() => onOpenDay(date)}
              className="w-full text-left bg-slate-800 hover:bg-slate-700 rounded-lg p-3 transition-colors"
            >
              <div className="flex items-start justify-between gap-2 mb-1">
                <span className="text-xs text-slate-400">
                  {dateObj.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })} ·{' '}
                  {MONTH_NAMES_PT[(dateObj.getMonth())].slice(0, 3)}
                </span>
                <div className="flex gap-1.5 shrink-0">
                  <StatusDot status={entry.status} />
                  {entry.difficulty && <DiffDot difficulty={entry.difficulty} />}
                </div>
              </div>
              <p className="text-sm text-slate-200 font-medium truncate">{schedule?.theme ?? '—'}</p>
              <p className="text-xs text-slate-500 truncate mt-0.5">{entry.originalText.slice(0, 80)}</p>
              <div className="flex gap-3 mt-1">
                <span className="text-xs text-slate-600">{entry.wordCount} pal.</span>
                {schedule?.verbTense && <span className="text-xs text-blue-600">{schedule.verbTense}</span>}
              </div>
            </button>
          );
        })}
        {filtered.length === 0 && (
          <p className="text-center text-slate-500 text-sm py-8">Nenhum resultado encontrado.</p>
        )}
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: Status }) {
  const map: Record<Status, string> = {
    'nao-iniciado': 'bg-slate-600',
    'escrito': 'bg-blue-500',
    'corrigido': 'bg-amber-500',
    'revisado': 'bg-green-500',
  };
  return <span className={`inline-block w-2 h-2 rounded-full mt-1 ${map[status]}`} />;
}

function DiffDot({ difficulty }: { difficulty: Difficulty }) {
  if (!difficulty) return null;
  const map: Record<string, string> = { facil: 'text-green-500', medio: 'text-amber-500', dificil: 'text-red-500' };
  const labels: Record<string, string> = { facil: 'F', medio: 'M', dificil: 'D' };
  return <span className={`text-xs font-bold ${map[difficulty]}`}>{labels[difficulty]}</span>;
}
