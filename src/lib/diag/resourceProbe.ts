/**
 * TEMPORARY diagnostic probe (homolog only) to find the persistent Conversation
 * freeze. It monkey-patches the constructors of the resources that can be capped
 * per session — AudioContext / webkitAudioContext, RTCPeerConnection — plus
 * createMediaElementSource and getUserMedia, and keeps LIVE + TOTAL counters so we
 * can see on the device exactly what accumulates across repeated sessions and
 * screen leave/re-enter. Everything is fail-safe and installed once.
 *
 * Read it via the on-screen ResourceProbeBadge. REMOVE once the leak is found.
 */
export interface ProbeSnapshot {
  acLive: number;
  acTotal: number;
  pcLive: number;
  pcTotal: number;
  srcTotal: number; // createMediaElementSource calls
  micTotal: number; // getUserMedia calls
}

const state: ProbeSnapshot = {
  acLive: 0,
  acTotal: 0,
  pcLive: 0,
  pcTotal: 0,
  srcTotal: 0,
  micTotal: 0,
};

type Listener = (s: ProbeSnapshot) => void;
const listeners = new Set<Listener>();
let installed = false;

function notify() {
  const snap = { ...state };
  listeners.forEach((l) => {
    try {
      l(snap);
    } catch {
      /* ignore */
    }
  });
}

export function getProbeSnapshot(): ProbeSnapshot {
  return { ...state };
}

export function subscribeProbe(l: Listener): () => void {
  listeners.add(l);
  l({ ...state });
  return () => listeners.delete(l);
}

export function resetProbeLive(): void {
  // Only the totals keep history; live counters are the leak signal.
  state.acTotal = state.acLive;
  state.pcTotal = state.pcLive;
  state.srcTotal = 0;
  state.micTotal = 0;
  notify();
}

function patchConstructor(
  ownerKey: 'acLive' | 'pcLive',
  totalKey: 'acTotal' | 'pcTotal',
  names: string[],
) {
  const g = window as unknown as Record<string, unknown>;
  for (const name of names) {
    const Orig = g[name] as (new (...a: unknown[]) => { close?: () => unknown }) | undefined;
    if (!Orig || (Orig as unknown as { __probed?: boolean }).__probed) continue;
    class Probed extends (Orig as new (...a: unknown[]) => { close?: () => unknown }) {
      constructor(...args: unknown[]) {
        super(...args);
        state[totalKey]++;
        state[ownerKey]++;
        notify();
        const self = this as { close?: () => unknown };
        const origClose = typeof self.close === 'function' ? self.close.bind(self) : null;
        if (origClose) {
          self.close = () => {
            state[ownerKey] = Math.max(0, state[ownerKey] - 1);
            notify();
            return origClose();
          };
        }
      }
    }
    (Probed as unknown as { __probed?: boolean }).__probed = true;
    g[name] = Probed;
  }
}

/** Install the probes. Idempotent; fail-safe; no-op off the DOM. */
export function installResourceProbe(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  try {
    patchConstructor('acLive', 'acTotal', ['AudioContext', 'webkitAudioContext']);
    patchConstructor('pcLive', 'pcTotal', ['RTCPeerConnection', 'webkitRTCPeerConnection']);

    // createMediaElementSource — count source nodes bound to any context.
    for (const acName of ['AudioContext', 'webkitAudioContext']) {
      const AC = (window as unknown as Record<string, unknown>)[acName] as
        | { prototype: { createMediaElementSource?: (...a: unknown[]) => unknown } }
        | undefined;
      const proto = AC?.prototype;
      const orig = proto?.createMediaElementSource;
      if (proto && typeof orig === 'function' && !(orig as { __probed?: boolean }).__probed) {
        const wrapped = function (this: unknown, ...args: unknown[]) {
          state.srcTotal++;
          notify();
          return (orig as (...a: unknown[]) => unknown).apply(this, args);
        };
        (wrapped as { __probed?: boolean }).__probed = true;
        proto.createMediaElementSource = wrapped;
      }
    }

    // getUserMedia — count mic acquisitions.
    const md = navigator?.mediaDevices as
      | { getUserMedia?: (...a: unknown[]) => Promise<unknown> }
      | undefined;
    if (md && typeof md.getUserMedia === 'function' && !(md.getUserMedia as { __probed?: boolean }).__probed) {
      const orig = md.getUserMedia.bind(md);
      const wrapped = (...args: unknown[]) => {
        state.micTotal++;
        notify();
        return orig(...args);
      };
      (wrapped as { __probed?: boolean }).__probed = true;
      md.getUserMedia = wrapped as typeof md.getUserMedia;
    }
  } catch {
    /* diagnostics must never break the app */
  }
}
