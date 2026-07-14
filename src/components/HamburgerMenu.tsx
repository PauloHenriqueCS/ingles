import type { View } from '../types';

interface MenuItem {
  view: View;
  label: string;
  icon: string;
}

const MENU_ITEMS: MenuItem[] = [
  { view: 'home',         label: 'Página inicial',   icon: '🏠' },
  { view: 'dashboard',    label: 'Meu dashboard',    icon: '📊' },
  { view: 'month',        label: 'Calendário',       icon: '📅' },
  { view: 'year',         label: 'Anual',            icon: '📈' },
  { view: 'filters',      label: 'Filtros',          icon: '🔍' },
  { view: 'history',      label: 'Histórico',        icon: '📋' },
  { view: 'evolution',    label: 'Evolução',         icon: '🚀' },
  { view: 'memory',       label: 'Memória',          icon: '🧠' },
  { view: 'conversation', label: 'Conversar com IA', icon: '🎙️' },
];

interface Props {
  current: View;
  onNavigate: (v: View) => void;
  onClose: () => void;
  onLogout: () => void;
}

export default function HamburgerMenu({ current, onNavigate, onClose, onLogout }: Props) {
  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 z-30"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer */}
      <nav
        className="fixed top-0 left-0 bottom-0 w-72 bg-slate-800 z-40 flex flex-col shadow-2xl"
        role="navigation"
        aria-label="Menu principal"
      >
        <div className="flex items-center justify-between px-4 h-14 border-b border-slate-700 shrink-0">
          <span className="text-sm font-semibold text-slate-200">Menu</span>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
            aria-label="Fechar menu"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {MENU_ITEMS.map((item) => (
            <button
              key={item.view}
              onClick={() => { onNavigate(item.view); onClose(); }}
              className={`w-full flex items-center gap-3 px-4 py-3 text-sm transition-colors text-left ${
                current === item.view
                  ? 'bg-blue-600/20 text-blue-400'
                  : 'text-slate-300 hover:bg-slate-700'
              }`}
            >
              <span className="text-xl leading-none shrink-0" aria-hidden="true">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>

        <div className="border-t border-slate-700 p-4 shrink-0">
          <button
            onClick={onLogout}
            className="w-full text-left text-sm text-slate-500 hover:text-slate-300 transition-colors py-2 focus:outline-none focus:underline"
          >
            Sair da conta
          </button>
        </div>
      </nav>
    </>
  );
}
