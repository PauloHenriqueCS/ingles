import { EntriesStore } from '../types';
import { computeStats } from '../utils/stats';
import { MONTH_NAMES_PT } from '../data/calendar2026';

interface Props {
  entries: EntriesStore;
  onOpenMonth: (month: number) => void;
}

export default function YearView({ entries, onOpenMonth }: Props) {
  const stats = computeStats(entries);
  const todaySP = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const currentYear = parseInt(todaySP.slice(0, 4), 10);
  const currentMonth = parseInt(todaySP.slice(5, 7), 10);

  return (
    <div className="p-4 max-w-lg mx-auto">
      <h2 className="font-semibold text-slate-100 mb-2">Progresso {currentYear}</h2>
      <p className="text-sm text-slate-400 mb-6">
        {stats.textsThisYear} textos escritos · {stats.totalWords.toLocaleString('pt-BR')} palavras
      </p>

      <div className="grid grid-cols-2 gap-3">
        {stats.monthlyStats.map((ms) => {
          const pct = ms.total > 0 ? Math.round((ms.written / ms.total) * 100) : 0;
          const isPast = ms.month < currentMonth;
          const isCurrent = ms.month === currentMonth;

          return (
            <button
              key={ms.month}
              onClick={() => onOpenMonth(ms.month)}
              className={`text-left bg-slate-800 rounded-lg p-4 hover:bg-slate-700 transition-colors border ${
                isCurrent ? 'border-blue-600' : 'border-transparent'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-slate-200">
                  {MONTH_NAMES_PT[ms.month - 1]}
                </span>
                {isPast && pct === 0 && (
                  <span className="text-xs text-red-400">—</span>
                )}
              </div>
              <div className="h-2 bg-slate-700 rounded-full overflow-hidden mb-2">
                <div
                  className={`h-full rounded-full transition-all ${
                    pct >= 80 ? 'bg-green-500' : pct >= 50 ? 'bg-blue-500' : pct > 0 ? 'bg-amber-500' : 'bg-slate-600'
                  }`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-slate-400">
                <span>{ms.written}/{ms.total} dias</span>
                <span className="font-medium text-slate-300">{pct}%</span>
              </div>
              {ms.totalWords > 0 && (
                <p className="text-xs text-slate-500 mt-1">{ms.totalWords.toLocaleString('pt-BR')} pal.</p>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
