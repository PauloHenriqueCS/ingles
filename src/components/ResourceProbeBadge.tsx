import { useEffect, useState } from 'react';
import { subscribeProbe, resetProbeLive, type ProbeSnapshot } from '../lib/diag/resourceProbe';

/**
 * TEMPORARY on-screen readout for the resource probe (homolog diagnosis of the
 * Conversation freeze). Round 1 ruled out AudioContext (AC). This shows the
 * remaining suspects. NEVER rendered in production. Tap to reset. REMOVE with the
 * probe once the leak is found.
 *
 * Reading it during a test (do sessions until it freezes):
 *   - MICt (live mic tracks) climbing (1→2→3→4) → mic streams not stopped = leak.
 *   - INT (live intervals) climbing per session → a timer leak = the cause.
 *   - HEAP climbing a lot per session → a memory/DOM leak.
 *   - Everything flat but frozen → the stall is a hung network/WebRTC connection.
 */
export default function ResourceProbeBadge() {
  const [s, setS] = useState<ProbeSnapshot | null>(null);

  const isProd =
    typeof window !== 'undefined' && window.location.hostname === 'app.orodim.com.br';

  useEffect(() => {
    if (isProd) return;
    return subscribeProbe(setS);
  }, [isProd]);

  if (isProd || !s) return null;

  // A single live session is normal for each; more than one = accumulation.
  // An overlay left mounted after a celebration ended is a render-side leak.
  const leak = s.micTracksLive > 1 || s.pcLive > 1 || s.overlaysLive > 0;

  return (
    <button
      type="button"
      onClick={resetProbeLive}
      title="Toque para zerar o contador de mic"
      style={{
        position: 'fixed',
        top: 'calc(env(safe-area-inset-top) + 6px)',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 2147483647,
        font: '600 11px/1.2 ui-monospace, Menlo, monospace',
        color: '#e2e8f0',
        background: leak ? 'rgba(190,18,60,0.92)' : 'rgba(2,6,23,0.9)',
        border: '1px solid rgba(148,163,184,0.4)',
        borderRadius: 8,
        padding: '4px 8px',
        letterSpacing: '0.02em',
        pointerEvents: 'auto',
        maxWidth: '96vw',
      }}
    >
      PC {s.pcLive} · MIC {s.micTracksLive}/{s.micTotal} · SVG {s.svgLive} · OV {s.overlaysLive} · DOM {s.domNodes} · {s.heapMb}MB
    </button>
  );
}
