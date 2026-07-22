import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { StatusBar, Style } from '@capacitor/status-bar'
import { isNativeApp, isPluginAvailable, runtimeAttribute } from './lib/runtimeEnvironment'
import { installChunkReloadRecovery } from './lib/chunkReloadRecovery'
import './index.css'
import App from './App.tsx'

installChunkReloadRecovery()

document.documentElement.dataset.runtime = runtimeAttribute()

if (isNativeApp && isPluginAvailable('StatusBar')) {
  StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {})
  StatusBar.setBackgroundColor({ color: '#0f172a' }).catch(() => {})
  StatusBar.setStyle({ style: Style.Dark }).catch(() => {})
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
