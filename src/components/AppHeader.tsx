interface Props {
  onMenuOpen: () => void;
  title?: string;
}

export default function AppHeader({ onMenuOpen, title }: Props) {
  return (
    <header className="fixed top-0 left-0 right-0 h-14 bg-slate-900 border-b border-slate-800 flex items-center px-4 z-20">
      <button
        onClick={onMenuOpen}
        className="w-10 h-10 flex flex-col justify-center items-center gap-[5px] rounded-lg hover:bg-slate-800 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
        aria-label="Abrir menu"
      >
        <span className="block w-5 h-0.5 bg-slate-300 rounded-full" />
        <span className="block w-5 h-0.5 bg-slate-300 rounded-full" />
        <span className="block w-5 h-0.5 bg-slate-300 rounded-full" />
      </button>
      {title && (
        <h1 className="ml-3 text-sm font-semibold text-slate-100">{title}</h1>
      )}
    </header>
  );
}
