/**
 * TEMPORARY diagnostic probe (homolog only) to find the persistent Conversation
 * freeze. First round showed AC/PC/SRC are clean (no AudioContext leak). This
 * round instruments the remaining per-session suspects that accumulate and are
 * cleared only by an app restart:
 *   - LIVE microphone tracks (getUserMedia tracks not yet .stop()'d / ended)
 *   - LIVE setInterval timers (setInterval - clearInterval)
 *   - JS heap (Chromium performance.memory), in MB
 * Still tracks AC/PC live to confirm they stay flat. Fail-safe, installed once.
 * Read it via the on-screen ResourceProbeBadge. REMOVE once the leak is found.
 */
export interface ProbeSnapshot {
  acLive: number;
  pcLive: number;
  micTracksLive: number; // mic tracks currently live
  micTotal: number; // getUserMedia calls
  intLive: number; // setInterval timers currently live
  heapMb: number; // JS heap used, MB (0 if unavailable)
}

const state: ProbeSnapshot = {
  acLive: 0,
  pcLive: 0,
  micTracksLive: 0,
  micTotal: 0,
  intLive: 0,
  heapMb: 0,
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

const micTracks = new Set<MediaStreamTrack>();

export function resetProbeLive(): void {
  // Live counters are the leak signal; totals reset for a clean run.
  state.micTotal = 0;
  notify();
}

function patchConstructor(ownerKey: 'acLive' | 'pcLive', names: string[]) {
  const g = window as unknown as Record<string, unknown>;
  for (const name of names) {
    const Orig = g[name] as (new (...a: unknown[]) => { close?: () => unknown }) | undefined;
    if (!Orig || (Orig as unknown as { __probed?: boolean }).__probed) continue;
    class Probed extends (Orig as new (...a: unknown[]) => { close?: () => unknown }) {
      constructor(...args: unknown[]) {
        super(...args);
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

function trackMicStream(stream: MediaStream) {
  try {
    stream.getAudioTracks().forEach((t) => {
      if (micTracks.has(t)) return;
      micTracks.add(t);
      const drop = () => {
        micTracks.delete(t);
        state.micTracksLive = micTracks.size;
        notify();
      };
      t.addEventListener('ended', drop);
    });
    state.micTracksLive = micTracks.size;
    notify();
  } catch {
    /* ignore */
  }
}

/** Install the probes. Idempotent; fail-safe; no-op off the DOM. */
export function installResourceProbe(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  try {
    patchConstructor('acLive', ['AudioContext', 'webkitAudioContext']);
    patchConstructor('pcLive', ['RTCPeerConnection', 'webkitRTCPeerConnection']);

    // MediaStreamTrack.stop → drop from live mic set.
    const MST = (window as unknown as { MediaStreamTrack?: { prototype: MediaStreamTrack } }).MediaStreamTrack;
    const proto = MST?.prototype as (MediaStreamTrack & { __probed?: boolean }) | undefined;
    if (proto && typeof proto.stop === 'function' && !proto.__probed) {
      const origStop = proto.stop;
      proto.stop = function (this: MediaStreamTrack) {
        if (micTracks.has(this)) {
          micTracks.delete(this);
          state.micTracksLive = micTracks.size;
          notify();
        }
        return origStop.apply(this);
      };
      proto.__probed = true;
    }

    // getUserMedia → count calls + track live mic tracks.
    const md = navigator?.mediaDevices as
      | { getUserMedia?: (...a: unknown[]) => Promise<MediaStream> }
      | undefined;
    if (md && typeof md.getUserMedia === 'function' && !(md.getUserMedia as { __probed?: boolean }).__probed) {
      const orig = md.getUserMedia.bind(md);
      const wrapped = (...args: unknown[]) => {
        state.micTotal++;
        notify();
        return orig(...args).then((stream) => {
          trackMicStream(stream);
          return stream;
        });
      };
      (wrapped as { __probed?: boolean }).__probed = true;
      md.getUserMedia = wrapped as typeof md.getUserMedia;
    }

    // setInterval / clearInterval → live timer count.
    const w = window as unknown as {
      setInterval: (...a: unknown[]) => number;
      clearInterval: (id?: number) => void;
    };
    const liveIntervals = new Set<number>();
    const origSet = w.setInterval;
    if (!(origSet as { __probed?: boolean }).__probed) {
      const wrappedSet = (...a: unknown[]) => {
        const id = origSet(...a);
        liveIntervals.add(id);
        state.intLive = liveIntervals.size;
        notify();
        return id;
      };
      (wrappedSet as { __probed?: boolean }).__probed = true;
      w.setInterval = wrappedSet as typeof w.setInterval;
      const origClear = w.clearInterval;
      w.clearInterval = (id?: number) => {
        if (id != null) {
          liveIntervals.delete(id);
          state.intLive = liveIntervals.size;
          notify();
        }
        return origClear(id);
      };
    }

    // Heap sampling (Chromium only).
    const sampleHeap = () => {
      const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
      if (mem && typeof mem.usedJSHeapSize === 'number') {
        const mb = Math.round(mem.usedJSHeapSize / (1024 * 1024));
        if (mb !== state.heapMb) {
          state.heapMb = mb;
          notify();
        }
      }
    };
    sampleHeap();
    origSet(sampleHeap, 1000);
  } catch {
    /* diagnostics must never break the app */
  }
}
