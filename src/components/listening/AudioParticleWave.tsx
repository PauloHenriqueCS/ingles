import { useEffect, useRef } from 'react';

/**
 * CAMADA C — the AI/audio particle mesh.
 *
 * A procedural "digital cloth" of stacked sine curves rendered as small
 * particles on a Canvas 2D surface. It is driven by the player STATE (playing /
 * paused) plus a smoothed pseudo-energy signal — NOT by a Web Audio
 * AnalyserNode. See CircularAudioPlayer for the rationale: the Listening audio
 * element is a bare `new Audio()` pointed at a cross-origin signed URL (or a
 * blob) and is recreated / re-sourced across parts, so wiring a
 * MediaElementAudioSourceNode risks CORS-tainted silence and the same
 * AudioContext-leak / once-only-binding hazards documented in AIAvatar.tsx.
 * A procedural signal gives the "reacts to speech" feel with zero risk to
 * playback on iOS/Safari/Capacitor.
 *
 * Performance: single RAF, dpr capped at 2, fillRect particles (no shadowBlur),
 * additive compositing for glow, RAF paused when the tab is hidden, and a single
 * static frame (no loop) under prefers-reduced-motion.
 */
interface Props {
  playing: boolean;
  reducedMotion: boolean;
}

const LINES = 20;
const POINTS = 46;

export default function AudioParticleWave({ playing, reducedMotion }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number>(0);
  // Live state read inside the RAF closure without re-subscribing the effect.
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const energyRef = useRef(0);
  const timeRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = 1;
    let H = 1;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      W = Math.max(1, Math.round(rect.width));
      H = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      // Under reduced motion there is no RAF loop to self-correct the first
      // frame, so redraw the static frame whenever layout changes.
      ro = new ResizeObserver(() => {
        resize();
        if (reducedMotion) draw();
      });
      ro.observe(canvas);
    }

    const draw = () => {
      const cy = H / 2;
      const t = timeRef.current;

      // Pseudo-speech energy: organic swell when playing, calm floor when paused.
      const swell =
        0.5 +
        0.28 * Math.sin(t * 1.7) +
        0.16 * Math.sin(t * 3.3 + 1.1) +
        0.07 * Math.sin(t * 5.2 + 0.4);
      const target = playingRef.current ? Math.max(0.28, Math.min(1, swell)) : 0.07;
      energyRef.current += (target - energyRef.current) * 0.08; // smoothing
      const energy = energyRef.current;

      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';

      const band = H * 0.46;
      const baseAmp = H * 0.05;
      const reactiveAmp = H * 0.15;
      const partBase = Math.max(0.7, W * 0.0042);

      for (let l = 0; l < LINES; l++) {
        const ln = l / (LINES - 1); // 0..1
        const depth = 1 - Math.abs(ln - 0.5) * 2; // 1 at centre, 0 at edges
        // Slow per-line vertical drift so curves overlap → "cloth"/3D feel.
        const baseY = cy + (ln - 0.5) * band + Math.sin(t * 0.4 + l * 0.9) * H * 0.025;
        const phase = l * 0.55;
        const amp = (baseAmp + reactiveAmp * energy) * (0.5 + 0.5 * depth);
        const speed = 1.1 + ln * 0.5;
        const size = (partBase + depth * 0.9) * (0.7 + 0.5 * energy);

        for (let p = 0; p < POINTS; p++) {
          const px = p / (POINTS - 1); // 0..1
          const x = px * W;
          const edgeFade = 0.35 + 0.65 * Math.sin(px * Math.PI); // soften line ends
          const y =
            baseY +
            Math.sin(px * 6.5 + t * speed + phase) * amp * edgeFade +
            Math.sin(px * 3.1 - t * (0.8 + ln * 0.4) + phase) * amp * 0.45 * edgeFade;

          const alpha = (0.1 + 0.5 * depth) * (0.35 + 0.65 * edgeFade);
          // Colour: blue (back/edges) → purple (front/centre).
          const mix = 0.35 + 0.5 * depth;
          const rC = Math.round(96 + (168 - 96) * mix);
          const gC = Math.round(165 + (85 - 165) * mix);
          const bC = Math.round(250 + (247 - 250) * mix);
          ctx.fillStyle = `rgba(${rC},${gC},${bC},${alpha})`;
          ctx.fillRect(x - size / 2, y - size / 2, size, size);
        }
      }

      ctx.globalCompositeOperation = 'source-over';
    };

    if (reducedMotion) {
      // Single calm but clearly-present static frame — no animation loop.
      timeRef.current = 1.3;
      energyRef.current = 0.4;
      draw();
      return () => {
        ro?.disconnect();
      };
    }

    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      // Advance time; slower while paused so idle motion stays calm.
      timeRef.current += dt * (playingRef.current ? 1 : 0.35);
      draw();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(rafRef.current);
      } else {
        last = performance.now();
        rafRef.current = requestAnimationFrame(loop);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelAnimationFrame(rafRef.current);
      document.removeEventListener('visibilitychange', onVisibility);
      ro?.disconnect();
    };
  }, [reducedMotion]);

  return <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-hidden="true" />;
}
