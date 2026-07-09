import { EntriesStore } from '../types';
import { computeStats } from '../utils/stats';
import { MONTH_NAMES_PT } from '../data/calendar2026';

interface Props {
  entries: EntriesStore;
  today: string;
  onOpenDay: (date: string) => void;
}

export default function Dashboard({ entries, today, onOpenDay }: Props) {
  const stats = computeStats(entries);

  const recentWritten = Object.values(entries)
    .filter((e) => e.originalText.trim().length > 0)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5);

  const todayEntry = entries[today];
  const todayWritten = todayEntry && todayEntry.originalText.trim().length > 0;
  const { aiStats } = stats;

  return (
    <div className="p-4 max-w-lg mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-slate-100">English Writing Calendar</h1>
        <p className="text-slate-400 text-sm mt-1">
          {new Date(today + 'T12:00:00').toLocaleDateString('pt-BR', {
            weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
          })}
        </p>
      </div>

      {/* Today's entry */}
      <button
        onClick={() => onOpenDay(today)}
        className={`w-full text-left rounded-lg p-4 mb-6 border transition-colors ${
          todayWritten
            ? 'bg-green-900/30 border-green-700'
            : 'bg-blue-900/30 border-blue-700'
        }`}
      >
        <p className="text-xs text-slate-400 mb-1">Hoje</p>
        <p className="font-medium text-slate-100">
          {todayWritten ? '✓ Texto do dia escrito' : 'Escrever texto de hoje →'}
        </p>
        {todayEntry?.originalText && (
          <p className="text-slate-400 text-sm mt-1 line-clamp-2">{todayEntry.originalText}</p>
        )}
      </button>

      {/* Writing stats */}
      <div className="grid grid-cols-2 gap-3 mb-6">
        <StatCard label="Textos este mês" value={stats.textsThisMonth} />
        <StatCard label="Textos este ano" value={stats.textsThisYear} />
        <StatCard label="Sequência atual" value={`${stats.currentStreak}d`} />
        <StatCard label="Maior sequência" value={`${stats.bestStreak}d`} />
        <StatCard label="Total de palavras" value={stats.totalWords.toLocaleString('pt-BR')} />
        <StatCard label="Média por texto" value={`${stats.avgWords} pal.`} />
      </div>

      {/* AI stats — shown only when at least one review exists */}
      {aiStats.reviewedCount > 0 && (
        <div className="bg-slate-800 rounded-lg p-4 mb-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-slate-300">Avaliação IA</h2>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">{aiStats.reviewedCount} revisões</span>
              {aiStats.latestLevel && (
                <span className="px-2 py-0.5 rounded bg-blue-900 text-blue-300 text-xs font-bold">
                  {aiStats.latestLevel}
                </span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <MiniScoreCard label="Nota média" value={aiStats.avgScore} />
            <MiniScoreCard label="Gramática" value={aiStats.avgGrammar} />
            <MiniScoreCard label="Vocabulário" value={aiStats.avgVocabulary} />
            <MiniScoreCard label="Naturalidade" value={aiStats.avgNaturalness} />
            <MiniScoreCard label="Fluência" value={aiStats.avgFluency} />
          </div>

          {/* Monthly evolution */}
          {aiStats.monthlyAvgScores.some((m) => m.count > 0) && (
            <div>
              <p className="text-xs text-slate-500 mb-2">Evolução mensal</p>
              <div className="space-y-1.5">
                {aiStats.monthlyAvgScores
                  .filter((m) => m.count > 0)
                  .map((m) => (
                    <div key={m.month} className="flex items-center gap-2">
                      <span className="text-xs text-slate-400 w-8">{MONTH_NAMES_PT[m.month - 1].slice(0, 3)}</span>
                      <div className="flex-1 h-2 bg-slate-700 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            m.avgScore >= 75 ? 'bg-green-500' :
                            m.avgScore >= 50 ? 'bg-amber-500' : 'bg-red-500'
                          }`}
                          style={{ width: `${m.avgScore}%` }}
                        />
                      </div>
                      <span className="text-xs text-slate-400 w-8 text-right tabular-nums">{m.avgScore}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Monthly writing consistency */}
      <div className="bg-slate-800 rounded-lg p-4 mb-6">
        <h2 className="text-sm font-medium text-slate-300 mb-3">Consistência mensal</h2>
        <div className="space-y-2">
          {stats.monthlyStats.map((ms) => {
            const pct = ms.total > 0 ? Math.round((ms.written / ms.total) * 100) : 0;
            return (
              <div key={ms.month} className="flex items-center gap-2">
                <span className="text-xs text-slate-400 w-8">{MONTH_NAMES_PT[ms.month - 1].slice(0, 3)}</span>
                <div className="flex-1 h-2 bg-slate-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500 rounded-full transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="text-xs text-slate-400 w-16 text-right">
                  {ms.written}/{ms.total}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Recent entries */}
      {recentWritten.length > 0 && (
        <div className="bg-slate-800 rounded-lg p-4">
          <h2 className="text-sm font-medium text-slate-300 mb-3">Recentes</h2>
          <div className="space-y-2">
            {recentWritten.map((e) => (
              <button
                key={e.date}
                onClick={() => onOpenDay(e.date)}
                className="w-full text-left flex items-center gap-3 py-2 border-b border-slate-700 last:border-0"
              >
                <span className="text-xs text-slate-400 w-20 shrink-0">
                  {new Date(e.date + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}
                </span>
                <span className="text-sm text-slate-300 truncate flex-1">
                  {e.title ? e.title : e.originalText.slice(0, 60) + '…'}
                </span>
                <div className="flex items-center gap-2 shrink-0">
                  {e.aiReview && (
                    <span className={`text-xs font-bold tabular-nums ${
                      e.aiReview.score >= 75 ? 'text-green-400' :
                      e.aiReview.score >= 50 ? 'text-amber-400' : 'text-red-400'
                    }`}>{e.aiReview.score}</span>
                  )}
                  <StatusBadge status={e.status} />
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-slate-800 rounded-lg p-3">
      <p className="text-xs text-slate-400 mb-1">{label}</p>
      <p className="text-2xl font-bold text-slate-100">{value}</p>
    </div>
  );
}

function MiniScoreCard({ label, value }: { label: string; value: number }) {
  const color =
    value >= 75 ? 'text-green-400' :
    value >= 50 ? 'text-amber-400' : 'text-red-400';
  return (
    <div className="bg-slate-700/50 rounded-lg p-2.5">
      <p className="text-xs text-slate-500 mb-0.5">{label}</p>
      <p className={`text-xl font-bold tabular-nums ${color}`}>{value}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    'escrito': 'text-blue-400',
    'corrigido': 'text-amber-400',
    'revisado': 'text-green-400',
    'nao-iniciado': 'text-slate-500',
  };
  const labels: Record<string, string> = {
    'escrito': 'Escrito',
    'corrigido': 'Corrigido',
    'revisado': 'Revisado',
    'nao-iniciado': '—',
  };
  return <span className={`text-xs ${map[status] ?? ''}`}>{labels[status] ?? status}</span>;
}
