import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { StatusBar, Style } from '@capacitor/status-bar'
import { isNativeApp, isPluginAvailable, runtimeAttribute } from './lib/runtimeEnvironment'
import { installChunkReloadRecovery } from './lib/chunkReloadRecovery'
import { installNativeAuthDeepLinkHandler } from './lib/nativeAuthDeepLink'
import { installResourceProbe } from './lib/diag/resourceProbe'
import ResourceProbeBadge from './components/ResourceProbeBadge'
import { CelebrationProvider } from './celebration'
import './index.css'
import App from './App.tsx'

// TEMPORARY (homolog only): instrument capped-resource creation BEFORE any app
// code runs, so the Conversation-freeze probe catches every AudioContext/PC/mic.
installResourceProbe()

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CelebrationProvider>
      <App />
    </CelebrationProvider>
    <ResourceProbeBadge />
  </StrictMode>,
)
