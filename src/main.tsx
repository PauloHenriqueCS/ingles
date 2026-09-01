import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { StatusBar, Style } from '@capacitor/status-bar'
import { isNativeApp, isPluginAvailable, runtimeAttribute } from './lib/runtimeEnvironment'
import { installChunkReloadRecovery } from './lib/chunkReloadRecovery'
import { installNativeAuthDeepLinkHandler } from './lib/nativeAuthDeepLink'
import { CelebrationProvider } from './celebration'
import './index.css'
import App from './App.tsx'

installChunkReloadRecovery()
// Completes the Android Apple OAuth flow when the system browser returns via the
// com.orodim.app://auth/callback deep link (no-op on web / non-native).
installNativeAuthDeepLinkHandler()

document.documentElement.dataset.runtime = runtimeAttribute()

if (isNativeApp && isPluginAvailable('StatusBar')) {
  StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {})
  StatusBar.setBackgroundColor({ color: '#0f172a' }).catch(() => {})
  StatusBar.setStyle({ style: Style.Dark }).catch(() => {})
}

const root = createRoot(document.getElementById('root')!)

// DEV-ONLY isolated preview lab for the future streak celebration. Mounted for a
// single path, WITHOUT the real App or CelebrationProvider, so it can never touch
// streaks, the DB, or any product flow. Lazy-imported so it stays out of the main
// bundle. Mirrors the existing `/auth/callback` / `/reset-password` path checks.
if (window.location.pathname === '/dev/streak-celebration') {
  import('./dev/streak-celebration').then(({ StreakCelebrationLab }) => {
    root.render(
      <StrictMode>
        <StreakCelebrationLab />
      </StrictMode>,
    )
  })
} else {
  root.render(
    <StrictMode>
      <CelebrationProvider>
        <App />
      </CelebrationProvider>
    </StrictMode>,
  )
}
