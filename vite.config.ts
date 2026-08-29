import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Build stamp baked in at build time — surfaced small in the menu so a tester can
// confirm which bundle the (aggressively-caching) WebView actually loaded. A new
// deploy = a new value; if the menu still shows the old stamp, the device is on a
// stale cached bundle (kill the process / clear cache to refresh).
const BUILD_ID = new Date().toISOString()

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  test: {
    environment: 'node',
    exclude: ['**/node_modules/**', '**/tests/e2e/**', '**/.claude/**'],
  },
})
