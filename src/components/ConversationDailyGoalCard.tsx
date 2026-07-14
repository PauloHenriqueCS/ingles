export interface ConversationDailyGoalCardProps {
  accumulatedSec: number;
  goalMinutes: number;
}

export default function ConversationDailyGoalCard({ accumulatedSec, goalMinutes }: ConversationDailyGoalCardProps) {
  const totalMin = accumulatedSec / 60;
  const displayedMin = Math.floor(totalMin);
  const pct = Math.min(100, Math.round((totalMin / goalMinutes) * 100));
  const met = totalMin >= goalMinutes;
  const remaining = Math.ceil(goalMinutes - totalMin);

  return (
    <div
      className="bg-slate-800 rounded-2xl p-4 space-y-2"
      role="region"
      aria-label={`Meta diária de conversação. ${displayedMin} de ${goalMinutes} minutos concluídos.`}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-200">🎯 Meta diária</span>
        <span className={`text-sm font-semibold tabular-nums ${met ? 'text-green-400' : 'text-slate-300'}`}>
          {displayedMin} / {goalMinutes} min
        </span>
      </div>
      <div
        className="h-2 bg-slate-700 rounded-full overflow-hidden"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${pct}% da meta diária concluído`}
      >
        <div
          className={`h-full rounded-full transition-all duration-500 ${met ? 'bg-green-500' : 'bg-blue-500'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className={`text-xs ${met ? 'text-green-400 font-medium' : 'text-slate-400'}`}>
        {met ? '✅ Meta concluída' : `Faltam ${remaining} minuto${remaining !== 1 ? 's' : ''}`}
      </p>
    </div>
  );
}
