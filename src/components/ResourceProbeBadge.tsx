import { useEffect, useState } from 'react';
import { subscribeProbe, resetProbeLive, type ProbeSnapshot } from '../lib/diag/resourceProbe';

/**
 * TEMPORARY on-screen readout for the resource probe (homolog diagnosis of the
 * Conversation freeze). Shows LIVE/TOTAL counts of the resources that can be
 * capped per session. NEVER rendered in production. Tap to reset the counters
 * before a test run. REMOVE with the probe once the leak is found.
 *
 * Reading it during a test:
 *   - AC live climbing across sessions  → an AudioContext leak (the real cause).
 *   - AC live stays 1 but it still freezes → audio is NOT it; look at PC / mic.
 *   - PC live climbing → RTCPeerConnection leak.
 */
export default function ResourceProbeBadge() {
  const [s, setS] = useState<ProbeSnapshot | null>(null);

  // Never show in production.
  const isProd =
    typeof window !== 'undefined' && window.location.hostname === 'app.orodim.com.br';

  useEffect(() => {
    if (isProd) return;
    return subscribeProbe(setS);
  }, [isProd]);

  if (isProd || !s) return null;

  const acLeak = s.acLive > 1;
  const pcLeak = s.pcLive > 1;

  return (
    <button
      type="button"
      onClick={resetProbeLive}
      title="Toque para zerar os contadores"
      style={{
        position: 'fixed',
        top: 'calc(env(safe-area-inset-top) + 6px)',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 2147483647,
        font: '600 11px/1.2 ui-monospace, Menlo, monospace',
        color: '#e2e8f0',
        background: acLeak || pcLeak ? 'rgba(190,18,60,0.92)' : 'rgba(2,6,23,0.9)',
        border: '1px solid rgba(148,163,184,0.4)',
        borderRadius: 8,
        padding: '4px 8px',
        letterSpacing: '0.02em',
        pointerEvents: 'auto',
      }}
    >
      AC {s.acLive}/{s.acTotal} · SRC {s.srcTotal} · PC {s.pcLive}/{s.pcTotal} · MIC {s.micTotal}
    </button>
  );
}
