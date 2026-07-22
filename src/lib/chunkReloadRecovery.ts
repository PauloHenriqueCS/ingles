const RELOAD_ATTEMPTED_KEY = 'lemon:chunk-reload-attempted';

/**
 * Vite wraps every dynamic import() in the build (e.g. pronunciationService.ts's
 * `await import('microsoft-cognitiveservices-speech-sdk')`) with its own
 * __vitePreload helper, which dispatches this exact event on the window when
 * the fetch fails — including the specific failure this recovers from: a tab
 * that loaded index.html before a new deploy replaced /assets/* with
 * different content hashes, so the old chunk URL now 404s (masked by
 * vercel.json's SPA rewrite as a 200 text/html, which is why the browser
 * reports it as a MIME-type/module-script error rather than a plain 404).
 *
 * Deliberately scoped to this one Vite-specific event — never a generic
 * window 'error'/'unhandledrejection' handler — so this can never intercept
 * API failures, Azure/pronunciation-analysis errors, or any other runtime
 * error. Those keep whatever handling they already have, untouched.
 *
 * One reload per session (sessionStorage, cleared when the tab/session
 * ends): if a reload didn't fix it, a real deploy problem is far more likely
 * than another stale-chunk race, and reloading again would risk a loop.
 */
export function installChunkReloadRecovery(): void {
  window.addEventListener('vite:preloadError', () => {
    let alreadyAttempted = false;
    try {
      alreadyAttempted = sessionStorage.getItem(RELOAD_ATTEMPTED_KEY) === '1';
    } catch {
      // Storage unavailable (private mode, disabled storage) — treat as not
      // yet attempted; worst case is a single extra reload, never a loop
      // since the flag write below is also best-effort.
    }

    if (alreadyAttempted) {
      window.alert(
        'Não foi possível carregar uma parte do aplicativo mesmo após atualizar. ' +
        'Feche e abra o app novamente, ou recarregue a página em alguns instantes.',
      );
      return;
    }

    try {
      sessionStorage.setItem(RELOAD_ATTEMPTED_KEY, '1');
    } catch {
      // Best-effort — see above.
    }
    window.location.reload();
  });
}
