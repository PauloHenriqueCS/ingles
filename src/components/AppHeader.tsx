interface Props {
  onMenuOpen: () => void;
  onLogoClick?: () => void;
}

export default function AppHeader({ onMenuOpen, onLogoClick }: Props) {
  return (
    // paddingTop = safe-area inset: on Android 15+ the WebView draws edge-to-edge
    // (under the status bar), so the bar's content must sit below the clock/notch
    // or the hamburger ends up behind the status bar and untappable. env() is 0
    // when there's no inset, so this is a no-op on non-inset platforms.
    <header
      className="fixed top-0 left-0 right-0 bg-slate-900 border-b border-slate-800 z-20"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <div className="h-14 flex items-center px-4">

        {/* Hamburger — extremo esquerdo */}
        <button
          onClick={onMenuOpen}
          className="w-10 h-10 flex flex-col justify-center items-center gap-[5px] rounded-lg hover:bg-slate-800 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 shrink-0"
          aria-label="Abrir menu"
          data-tour="main-menu"
        >
          <span className="block w-5 h-0.5 bg-slate-300 rounded-full" />
          <span className="block w-5 h-0.5 bg-slate-300 rounded-full" />
          <span className="block w-5 h-0.5 bg-slate-300 rounded-full" />
        </button>

        {/* Logo — extremo direito */}
        <button
          onClick={onLogoClick}
          className="ml-auto flex items-center bg-transparent border-0 p-0 cursor-pointer rounded focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-slate-900"
          aria-label="Orodim — ir para o início"
          style={{ background: 'none' }}
        >
          <img
            src="/brand/lemon-logo.png"
            alt="Orodim"
            className="h-8 sm:h-10 w-auto object-contain"
            width={125}
            height={40}
            fetchPriority="high"
            draggable={false}
          />
        </button>

      </div>
    </header>
  );
}
