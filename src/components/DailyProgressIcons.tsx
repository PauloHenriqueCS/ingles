import { DailyActivityStatus, DailyProgress } from '../types';

interface Props {
  progress: DailyProgress;
}

function dotCls(status: DailyActivityStatus, completedColor: string): string {
  if (status === 'completed') return completedColor;
  if (status === 'in_progress') return 'bg-slate-400';
  return 'bg-slate-600';
}

export default function DailyProgressIcons({ progress }: Props) {
  return (
    <div className="flex items-center gap-0.5 mt-0.5">
      <div
        className={`w-1 h-1 rounded-full ${dotCls(progress.writing, 'bg-violet-400')}`}
        title="Escrita"
      />
      <div
        className={`w-1 h-1 rounded-full ${dotCls(progress.pronunciation, 'bg-blue-400')}`}
        title="Pronúncia"
      />
      <div
        className={`w-1 h-1 rounded-full ${dotCls(progress.conversation, 'bg-teal-400')}`}
        title="Conversação"
      />
    </div>
  );
}
