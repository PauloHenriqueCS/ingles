import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * Guards the web security-header policy declared in vercel.json for the
 * catch-all `/(.*)` source. These headers protect the remote-first origin
 * (app.orodim.com.br) that both the web app and the Capacitor Android WebView
 * load. Regressions here silently weaken CSP / transport security for mobile
 * too, so assert the contract explicitly.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const vercel = JSON.parse(readFileSync(join(repoRoot, 'vercel.json'), 'utf8')) as {
  headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>
}

function headersFor(source: string): Record<string, string> {
  const block = vercel.headers.find((h) => h.source === source)
  if (!block) throw new Error(`no headers block for source ${source}`)
  return Object.fromEntries(block.headers.map((h) => [h.key, h.value]))
}

describe('vercel.json security headers for /(.*)', () => {
  const h = headersFor('/(.*)')

  it('sets HSTS with a two-year max-age, subdomains and preload', () => {
    expect(h['Strict-Transport-Security']).toBe(
      'max-age=63072000; includeSubDomains; preload',
    )
  })

  it('sets nosniff, referrer policy and SAMEORIGIN framing', () => {
    expect(h['X-Content-Type-Options']).toBe('nosniff')
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin')
    expect(h['X-Frame-Options']).toBe('SAMEORIGIN')
  })

  it('locks down device features via Permissions-Policy (mic self only)', () => {
    const pp = h['Permissions-Policy']
    expect(pp).toContain('microphone=(self)')
    expect(pp).toContain('camera=()')
    expect(pp).toContain('geolocation=()')
    expect(pp).toContain('payment=()')
  })

  describe('Content-Security-Policy', () => {
    const csp = h['Content-Security-Policy']
    const directives = Object.fromEntries(
      csp
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => {
          const [name, ...values] = d.split(/\s+/)
          return [name, values]
        }),
    ) as Record<string, string[]>

    it('self-restricts default-src and forbids objects/plugins', () => {
      expect(directives['default-src']).toEqual(["'self'"])
      expect(directives['object-src']).toEqual(["'none'"])
      expect(directives['base-uri']).toEqual(["'self'"])
      expect(directives['frame-ancestors']).toEqual(["'self'"])
      expect(directives['form-action']).toEqual(["'self'"])
      expect(directives['frame-src']).toEqual(["'none'"])
    })

    it('keeps script-src locked to self with NO unsafe-inline', () => {
      expect(directives['script-src']).toEqual(["'self'"])
      expect(directives['script-src']).not.toContain("'unsafe-inline'")
    })

    it('allows the runtime backends the app depends on in connect-src', () => {
      const connect = directives['connect-src'].join(' ')
      // Supabase (REST + Realtime WS)
      expect(connect).toContain('https://*.supabase.co')
      expect(connect).toContain('wss://*.supabase.co')
      // OpenAI (chat + Realtime)
      expect(connect).toContain('https://api.openai.com')
      expect(connect).toContain('https://*.openai.com')
      // Azure Speech (STT/TTS over HTTPS + WSS)
      expect(connect).toContain('https://*.cognitiveservices.azure.com')
      expect(connect).toContain('wss://*.stt.speech.microsoft.com')
      expect(connect).toContain('wss://*.tts.speech.microsoft.com')
      // RevenueCat web + OneSignal web
      expect(connect).toContain('https://api.revenuecat.com')
      expect(connect).toContain('https://*.onesignal.com')
    })

    it('permits audio/media and blob workers used by speech + audio playback', () => {
      expect(directives['media-src']).toEqual(
        expect.arrayContaining(["'self'", 'blob:', 'data:']),
      )
      expect(directives['worker-src']).toEqual(
        expect.arrayContaining(["'self'", 'blob:']),
      )
    })

    it('upgrades insecure requests', () => {
      expect(csp).toContain('upgrade-insecure-requests')
    })
  })
})
