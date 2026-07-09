import { View } from '../types';

interface Props {
  current: View;
  onChange: (v: View) => void;
}

const tabs: { view: View; label: string; icon: string }[] = [
  { view: 'dashboard', label: 'Painel', icon: '📊' },
  { view: 'month', label: 'Calendário', icon: '📅' },
  { view: 'year', label: 'Anual', icon: '📈' },
  { view: 'filters', label: 'Filtros', icon: '🔍' },
  { view: 'history', label: 'Histórico', icon: '📋' },
  { view: 'evolution', label: 'Evolução', icon: '🚀' },
  { view: 'memory', label: 'Memória', icon: '🧠' },
];

export default function BottomNav({ current, onChange }: Props) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-slate-800 border-t border-slate-700 flex z-10">
      {tabs.map((t) => (
        <button
          key={t.view}
          onClick={() => onChange(t.view)}
          className={`flex-1 flex flex-col items-center gap-1 py-2 text-xs transition-colors ${
            current === t.view ? 'text-blue-400' : 'text-slate-400'
          }`}
        >
          <span className="text-lg leading-none">{t.icon}</span>
          {t.label}
        </button>
      ))}
    </nav>
  );
}
