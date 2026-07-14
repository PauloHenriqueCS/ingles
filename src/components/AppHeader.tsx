interface Props {
  onMenuOpen: () => void;
  onLogoClick?: () => void;
}

export default function AppHeader({ onMenuOpen, onLogoClick }: Props) {
  return (
    <header className="fixed top-0 left-0 right-0 h-14 bg-slate-900 border-b border-slate-800 flex items-center px-4 z-20 gap-3">

      {/* Hamburger */}
      <button
        onClick={onMenuOpen}
        className="w-10 h-10 flex flex-col justify-center items-center gap-[5px] rounded-lg hover:bg-slate-800 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 shrink-0"
        aria-label="Abrir menu"
      >
        <span className="block w-5 h-0.5 bg-slate-300 rounded-full" />
        <span className="block w-5 h-0.5 bg-slate-300 rounded-full" />
        <span className="block w-5 h-0.5 bg-slate-300 rounded-full" />
      </button>

      {/* Logo */}
      <button
        onClick={onLogoClick}
        className="flex items-center rounded focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-slate-900"
        aria-label="Lemon — ir para o início"
      >
        <img
          src="/brand/lemon-header.png"
          alt="Lemon"
          className="h-8 sm:h-9 md:h-10 w-auto object-contain"
          style={{ maxWidth: 160 }}
          fetchPriority="high"
          draggable={false}
        />
      </button>

    </header>
  );
}
