import { useEffect, useRef, useState } from 'react';

export type AvatarState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';

const reducedMotion =
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const STATE_RING: Record<AvatarState, string> = {
  idle:       '#14b8a6',
  connecting: '#14b8a6',
  listening:  '#22c55e',
  thinking:   '#38bdf8',
  speaking:   '#facc15',
  error:      '#ef4444',
};

const CORE_STOPS: Record<AvatarState, [string, string, string]> = {
  idle:       ['#93c5fd', '#0d9488', '#0c3547'],
  connecting: ['#93c5fd', '#0d9488', '#0c3547'],
  listening:  ['#6ee7b7', '#16a34a', '#052e16'],
  thinking:   ['#bae6fd', '#0891b2', '#0c2340'],
  speaking:   ['#fef08a', '#0d9488', '#0c3547'],
  error:      ['#fca5a5', '#b91c1c', '#2d0a0a'],
};

interface Props {
  state: AvatarState;
  size?: number;
}

// SHARED, app-lifetime Web Audio graph. These were per-instance refs, but the
// avatar is remounted on every conversation session status change, so each
// start→end cycle created a NEW AudioContext that was never closed — after a few
// cycles the WebView hit its AudioContext cap and the app froze (progressively
// worse each cycle). The `#realtime-audio` element is a persistent singleton and
// can be bound to `createMediaElementSource` only ONCE, so the whole graph must
// be created once and reused. One long-lived context (never closed) fixes the
// leak AND avoids the once-only-binding error, and keeps the AI voice routed
// through `ctx.destination` for the app's lifetime.
let sharedCtx: AudioContext | null = null;
let sharedAnalyser: AnalyserNode | null = null;
let sharedData: Uint8Array<ArrayBuffer> | null = null;
let sharedSource: MediaElementAudioSourceNode | null = null;
let sharedSourceEl: HTMLMediaElement | null = null;

export default function AIAvatar({ state, size = 120 }: Props) {
  const [amplitude, setAmplitude] = useState(0);
  const rafRef     = useRef<number>(0);
  const [hidden, setHidden] = useState(false);

  // Pause animations when tab is not visible
  useEffect(() => {
    const handle = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', handle);
    return () => document.removeEventListener('visibilitychange', handle);
  }, []);

  // Web Audio amplitude — only when speaking and motion is ok
  useEffect(() => {
    if (state !== 'speaking' || reducedMotion || hidden) {
      cancelAnimationFrame(rafRef.current);
      setAmplitude(0);
      return;
    }

    let cancelled = false;

    const setup = async () => {
      const audioEl = document.getElementById('realtime-audio') as HTMLAudioElement | null;
      if (!audioEl) return;
      try {
        // One shared context for the app's lifetime (see note above) — created
        // once, reused on every mount, never accumulated. Only recreated if it
        // was somehow closed (e.g. by the OS), which also invalidates the graph.
        if (!sharedCtx || sharedCtx.state === 'closed') {
          sharedCtx = new AudioContext();
          sharedAnalyser = null;
          sharedData = null;
          sharedSource = null;
          sharedSourceEl = null;
        }
        const ctx = sharedCtx;
        if (ctx.state === 'suspended') await ctx.resume();

        if (!sharedAnalyser) {
          const an = ctx.createAnalyser();
          an.fftSize = 256;
          an.smoothingTimeConstant = 0.75;
          sharedAnalyser = an;
          sharedData = new Uint8Array(an.frequencyBinCount) as Uint8Array<ArrayBuffer>;
        }

        // Bind the persistent audio element to the shared context ONCE. If the
        // element was recreated (left + re-entered the screen), bind the new one.
        if (!sharedSource || sharedSourceEl !== audioEl) {
          try {
            sharedSource = ctx.createMediaElementSource(audioEl);
            sharedSource.connect(ctx.destination);
            sharedSourceEl = audioEl;
          } catch {
            // Already bound once for this element's lifetime — keep the existing
            // source (its ctx.destination route keeps the AI voice audible).
          }
        }
        if (sharedSource && sharedAnalyser) sharedSource.connect(sharedAnalyser);

        const tick = () => {
          if (cancelled || !sharedAnalyser || !sharedData) return;
          sharedAnalyser.getByteFrequencyData(sharedData);
          let sum = 0;
          for (const v of sharedData) sum += (v / 255) ** 2;
          setAmplitude(Math.sqrt(sum / sharedData.length));
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch {
        // Fallback: no real amplitude, CSS-only animation
      }
    };

    setup();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      // Detach the analyser tap only — NEVER close the shared context or drop the
      // source→destination route, or the AI voice would go silent for the rest of
      // the app session.
      try { sharedSource?.disconnect(sharedAnalyser!); } catch { /* ignore */ }
      setAmplitude(0);
    };
  }, [state, hidden]);

  const ring   = STATE_RING[state];
  const [c0, c1, c2] = CORE_STOPS[state];
  const amp    = reducedMotion ? 0 : amplitude;
  const paused = hidden || reducedMotion;

  // CSS animation names based on state
  const coreAnim   = paused ? 'none' :
    (state === 'idle' || state === 'connecting') ? 'avatar-breathe 3.5s ease-in-out infinite' :
    (state === 'thinking') ? 'avatar-breathe 2s ease-in-out infinite' : 'none';

  const driftAnim = paused ? 'none' : 'avatar-drift 18s linear infinite';
  const driftAnim2 = paused ? 'none' : 'avatar-drift 26s linear infinite reverse';

  const showWaves  = (state === 'listening' || state === 'speaking') && !paused;
  const showOrbit  = state === 'thinking' && !paused;
  const showError  = state === 'error';

  // Amplitude-driven sizes (speaking)
  const coreR = state === 'speaking' ? 34 + amp * 7 : 34;
  const wave1R = 52 + amp * 24;
  const wave2R = 66 + amp * 18;
  const wave1Op = state === 'speaking' ? 0.28 + amp * 0.5 : 0;
  const wave2Op = state === 'speaking' ? 0.14 + amp * 0.28 : 0;
  const accentR  = 38 + amp * 10;
  const accentW  = amp * 2.5;
  const accentOp = amp * 0.7;

  return (
    <svg
      viewBox="0 0 200 200"
      width={size}
      height={size}
      role="img"
      aria-label={`Avatar do tutor — ${state}`}
      style={{ overflow: 'visible', display: 'block' }}
    >
      <defs>
        <radialGradient id="av-bg" cx="50%" cy="50%" r="50%">
          <stop offset="0%"   stopColor="#1a3a52" />
          <stop offset="100%" stopColor="#090f1a" />
        </radialGradient>

        <radialGradient id="av-core" cx="38%" cy="35%" r="65%">
          <stop offset="0%"   stopColor={c0} stopOpacity="0.95" />
          <stop offset="45%"  stopColor={c1} />
          <stop offset="100%" stopColor={c2} />
        </radialGradient>

        <radialGradient id="av-ambient" cx="50%" cy="50%" r="50%">
          <stop offset="0%"  stopColor={ring} stopOpacity="0.18" />
          <stop offset="100%" stopColor={ring} stopOpacity="0" />
        </radialGradient>

        <filter id="av-glow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>

        <filter id="av-soft" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Background */}
      <circle cx="100" cy="100" r="92" fill="url(#av-bg)" />

      {/* Ambient glow responds to state color */}
      <circle cx="100" cy="100" r="92" fill="url(#av-ambient)"
        style={{ transition: reducedMotion ? 'opacity 0.6s' : 'fill 0.6s, opacity 0.6s' }}
      />

      {/* Structural drifting rings — always present, add depth */}
      <circle
        cx="100" cy="100" r="74"
        fill="none" stroke={ring} strokeWidth="0.7"
        strokeDasharray="3 9" opacity="0.22"
        style={{
          transformBox: 'fill-box', transformOrigin: 'center',
          animation: driftAnim,
          transition: 'stroke 0.8s',
        }}
      />
      <circle
        cx="100" cy="100" r="60"
        fill="none" stroke={ring} strokeWidth="0.5"
        strokeDasharray="2 7" opacity="0.15"
        style={{
          transformBox: 'fill-box', transformOrigin: 'center',
          animation: driftAnim2,
          transition: 'stroke 0.8s',
        }}
      />

      {/* Listening: CSS-animated expanding rings */}
      {state === 'listening' && !paused && (
        <>
          <circle cx="100" cy="100" r="52" fill="none" stroke={ring} strokeWidth="1.5"
            opacity="0" className="av-ring-expand" />
          <circle cx="100" cy="100" r="52" fill="none" stroke={ring} strokeWidth="1"
            opacity="0" className="av-ring-expand av-ring-delay" />
        </>
      )}

      {/* Speaking: amplitude-driven rings */}
      {showWaves && state === 'speaking' && (
        <>
          <circle cx="100" cy="100" r={wave1R} fill="none" stroke={ring}
            strokeWidth={1.5 + amp * 1.5} opacity={wave1Op}
            style={{ transition: 'none' }}
          />
          <circle cx="100" cy="100" r={wave2R} fill="none" stroke={ring}
            strokeWidth={1 + amp} opacity={wave2Op}
            style={{ transition: 'none' }}
          />
          {/* Yellow-lemon accent ring */}
          <circle cx="100" cy="100" r={accentR} fill="none"
            stroke="#facc15" strokeWidth={accentW} opacity={accentOp}
            style={{ transition: 'none' }}
          />
        </>
      )}

      {/* Thinking: orbiting dots (3 evenly spaced via animation-delay) */}
      {showOrbit && (
        <>
          {[
            { color: '#38bdf8', r: 4.5, anim: 'av-orbit 2.6s linear infinite' },
            { color: '#22c55e', r: 3.5, anim: 'av-orbit 2.6s linear infinite', delay: '-0.87s' },
            { color: '#facc15', r: 3,   anim: 'av-orbit 2.6s linear infinite', delay: '-1.73s' },
          ].map(({ color, r, anim, delay }, i) => (
            <g key={i} style={{
              transformBox: 'fill-box', transformOrigin: 'center',
              animation: anim, animationDelay: delay,
            }}>
              <circle cx="100" cy="62" r={r} fill={color} opacity="0.85"
                filter="url(#av-soft)" />
            </g>
          ))}
        </>
      )}

      {/* Core orb */}
      <circle
        cx="100" cy="100"
        r={coreR}
        fill="url(#av-core)"
        filter="url(#av-glow)"
        style={{
          transformBox: 'fill-box', transformOrigin: 'center',
          animation: coreAnim,
          transition: reducedMotion ? 'fill 0.7s, opacity 0.7s' : 'r 0.08s ease-out',
        }}
      />

      {/* Error overlay */}
      {showError && (
        <circle cx="100" cy="100" r="34" fill="#ef4444" opacity="0.12" />
      )}

      {/* Glass highlight */}
      <ellipse cx="88" cy="87" rx="13" ry="9" fill="white" opacity="0.1" />
      <ellipse cx="84" cy="84" rx="5" ry="3.5" fill="white" opacity="0.18" />

      {/* Center focal point */}
      <circle cx="100" cy="100" r="5"
        fill={state === 'speaking' ? '#fef08a' : state === 'error' ? '#fca5a5' : '#e0f2fe'}
        opacity="0.9"
        filter="url(#av-soft)"
        style={{ transition: 'fill 0.4s' }}
      />

      {/* Connecting: subtle pulse indicator */}
      {state === 'connecting' && !paused && (
        <circle cx="100" cy="100" r="44" fill="none" stroke={ring}
          strokeWidth="1.5" opacity="0.4"
          className="av-ring-expand" />
      )}
    </svg>
  );
}
