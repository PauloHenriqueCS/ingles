import { useEffect, useRef } from 'react';
import { PenLine, Mic, MessagesSquare, Headphones, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { AppIcon } from './AppIcon';
import { DailyActivityStatus, DailyProgress } from '../types';

interface Props {
  date: string;
  progress: DailyProgress;
  convTotalSec: number;
  convGoalSec: number;
  onOpenDay: (date: string) => void;
  onClose: () => void;
}

function statusBadge(status: DailyActivityStatus): { text: string; cls: string } | null {
  if (status === 'coming_soon') return null;
  if (status === 'completed') return { text: '✓ Concluído', cls: 'text-green-400' };
  if (status === 'in_progress') return { text: 'Em andamento', cls: 'text-blue-400' };
  return { text: 'Não iniciado', cls: 'text-slate-500' };
}

function formatDatePtBr(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('pt-BR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

export default function DailyProgressModal({
  date,
  progress,
  convTotalSec,
  convGoalSec,
  onOpenDay,
  onClose,
}: Props) {
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const convMin = Math.floor(convTotalSec / 60);
  const goalMin = Math.round(convGoalSec / 60);

  type Row = {
    icon: LucideIcon;
    label: string;
    status: DailyActivityStatus;
    detail?: string;
    action?: () => void;
    actionLabel?: string;
  };

  const rows: Row[] = [
    {
      icon: PenLine,
      label: 'Escrita',
      status: progress.writing,
      action: () => { onOpenDay(date); onClose(); },
      actionLabel: 'Abrir',
    },
    {
      icon: Mic,
      label: 'Pronúncia',
      status: progress.pronunciation,
    },
    {
      icon: MessagesSquare,
      label: 'Conversação com IA',
      status: progress.conversation,
      detail: `${convMin} / ${goalMin} min`,
    },
    {
      icon: Headphones,
      label: 'Listening',
      status: progress.listening,
    },
  ];

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === backdropRef.current) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Progresso de ${formatDatePtBr(date)}`}
        className="w-full sm:max-w-md bg-slate-800 rounded-t-2xl sm:rounded-2xl shadow-2xl"
      >
        <div className="flex justify-center pt-3 pb-1 sm:hidden">
          <div className="w-10 h-1 bg-slate-600 rounded-full" />
        </div>

        <div className="px-5 pt-2 pb-6 sm:pt-5 sm:pb-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-slate-100">{formatDatePtBr(date)}</h2>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-200 w-8 h-8 flex items-center justify-center transition-all duration-150"
              aria-label="Fechar"
            >
              <AppIcon icon={X} className="w-5 h-5 shrink-0" />
            </button>
          </div>

          <div className="space-y-2">
            {rows.map((row) => {
              const badge = statusBadge(row.status);
              return (
                <div
                  key={row.label}
                  className="flex items-center gap-3 bg-slate-700/50 rounded-xl px-4 py-3"
                >
                  <AppIcon icon={row.icon} className="w-5 h-5 shrink-0 text-slate-400" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-slate-200">{row.label}</span>
                      {row.status === 'coming_soon' && (
                        <span className="text-[10px] bg-slate-600 text-slate-400 px-1.5 py-0.5 rounded-full leading-none">
                          Em breve
                        </span>
                      )}
                    </div>
                    {row.detail && (
                      <p className="text-xs text-slate-400 mt-0.5">{row.detail}</p>
                    )}
                    {badge && (
                      <p className={`text-xs mt-0.5 ${badge.cls}`}>{badge.text}</p>
                    )}
                  </div>
                  {row.action && (
                    <button
                      onClick={row.action}
                      className="text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors flex-shrink-0 px-2 py-1"
                    >
                      {row.actionLabel}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
