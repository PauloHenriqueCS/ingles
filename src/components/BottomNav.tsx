import {
  CalendarDays, History, TrendingUp, BookOpen,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { AppIcon } from './AppIcon';
import { View } from '../types';

interface Props {
  current: View;
  onChange: (v: View) => void;
}

const tabs: { view: View; label: string; icon: LucideIcon }[] = [
  { view: 'month',     label: 'Calendário', icon: CalendarDays },
  { view: 'history',   label: 'Histórico',  icon: History },
  { view: 'evolution', label: 'Evolução',   icon: TrendingUp },
  { view: 'memory',    label: 'Revisão',    icon: BookOpen },
];

export default function BottomNav({ current, onChange }: Props) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-slate-800 border-t border-slate-700 flex z-10">
      {tabs.map((t) => (
        <button
          key={t.view}
          onClick={() => onChange(t.view)}
          className={`flex-1 flex flex-col items-center gap-1 py-2 text-xs transition-all duration-150 ${
            current === t.view ? 'text-blue-400' : 'text-slate-400'
          }`}
        >
          <AppIcon icon={t.icon} />
          {t.label}
        </button>
      ))}
    </nav>
  );
}
