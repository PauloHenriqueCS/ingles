import { Play, Pause, Rewind, RotateCcw, Loader2 } from 'lucide-react';
import { useReducedMotion } from './useReducedMotion';
import AudioParticleWave from './AudioParticleWave';
import CircularAudioProgress from './CircularAudioProgress';
import MiniWaveform from './MiniWaveform';

/**
 * The redesigned Listening audio player: a circular, "audio + AI" composition.
 *
 * IMPORTANT: this component is purely PRESENTATIONAL. It owns no audio logic —
 * every action is a callback into ListeningView, which keeps driving the real
 * HTMLAudioElement exactly as before. The controls map 1:1 to the pre-existing
 * behaviour:
 *   - left  → seek back 10s (-10s), unchanged
 *   - centre→ play / pause, unchanged
 *   - right → "Reouvir" (restart the current block from 0), unchanged
 *   - speeds→ the existing 0.75/0.9/1/1.1/1.25 selector, unchanged
 * No seek-by-drag is introduced (the player never had one).
 */
export interface CircularAudioPlayerProps {
  playing: boolean;
  isReady: boolean;
  isMarking: boolean;
  /** Audio progress, 0..1. */
  progress: number;
  currentLabel: string;
  durationLabel: string;
  speed: number;
  speeds: readonly number[];
  /** Deterministic seed for the mini-waveform (stable per block/part). */
  waveformSeed: string;
  onPlay: () => void;
  onPause: () => void;
  onSeekBack: () => void;
  onReplay: () => void;
  onSelectSpeed: (speed: number) => void;
  /** aria-label for the right control. Defaults to "Reouvir". */
  replayAriaLabel?: string;
  /** title/tooltip for the right control. Defaults to "Reouvir bloco". */
  replayTitle?: string;
}

const CIRCLE_SIZE = 'min(86vw, 420px)';

export default function CircularAudioPlayer({
  playing,
  isReady,
  isMarking,
  progress,
  currentLabel,
  durationLabel,
  speed,
  speeds,
  waveformSeed,
  onPlay,
  onPause,
  onSeekBack,
  onReplay,
  onSelectSpeed,
  replayAriaLabel = 'Reouvir',
  replayTitle = 'Reouvir bloco',
}: CircularAudioPlayerProps) {
  const reducedMotion = useReducedMotion();
  const showPlay = isReady || !playing;

  return (
    <div className="flex flex-col items-center gap-5">
      <style>{`
        @keyframes lap-glow-pulse { 0%,100%{opacity:.55} 50%{opacity:1} }
        .lap-glow-pulse { animation: lap-glow-pulse 2.6s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .lap-glow-pulse { animation: none; opacity:.7; } }
      `}</style>

      {/* Circular composition */}
      <div className="relative" style={{ width: CIRCLE_SIZE, aspectRatio: '1 / 1' }}>
        {/* CAMADA A — base circle */}
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background: 'radial-gradient(circle at 50% 38%, #141b30 0%, #0b1020 68%, #090d1a 100%)',
            border: '1px solid rgba(99,102,241,0.16)',
            boxShadow:
              'inset 0 0 60px rgba(0,0,0,0.55), inset 0 0 18px rgba(79,70,229,0.10), 0 0 42px rgba(79,70,229,0.14)',
          }}
        />

        {/* CAMADA C — particle mesh, clipped inside the ring */}
        {!isMarking && (
          <div className="absolute overflow-hidden rounded-full" style={{ inset: '8%' }}>
            <AudioParticleWave playing={playing} reducedMotion={reducedMotion} />
          </div>
        )}

        {/* CAMADA B — progress ring + luminous dot */}
        <CircularAudioProgress progress={progress} />

        {/* Current-time pill (visual echo of existing state, mirrors the reference) */}
        <div className="absolute left-1/2 -translate-x-1/2" style={{ top: '12.5%' }}>
          <span className="rounded-full border border-slate-700/60 bg-slate-950/60 px-3 py-1 text-xs font-semibold tabular-nums text-slate-200">
            {currentLabel}
          </span>
        </div>

        {isMarking ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex flex-col items-center gap-2 text-slate-400">
              <Loader2 className="h-6 w-6 animate-spin text-purple-400" />
              <span className="text-xs">Processando...</span>
            </div>
          </div>
        ) : (
          <>
            {/* Left — back 10s */}
            <button
              onClick={onSeekBack}
              title="Voltar 10 segundos"
              aria-label="Voltar 10 segundos"
              className="group absolute top-1/2 flex -translate-y-1/2 flex-col items-center gap-1"
              style={{ left: '8%' }}
            >
              <span className="relative flex h-11 w-11 items-center justify-center rounded-full border border-slate-600/40 bg-slate-950/55 text-slate-300 backdrop-blur-sm transition-colors group-hover:border-indigo-400/50 group-hover:text-white group-active:scale-95">
                <Rewind className="h-4 w-4" />
                <span className="absolute bottom-1 right-1 text-[8px] font-bold leading-none text-slate-400">10</span>
              </span>
            </button>

            {/* Centre — play / pause */}
            <div className="absolute inset-0 flex items-center justify-center">
              <button
                onClick={showPlay ? onPlay : onPause}
                aria-label={showPlay ? 'Reproduzir' : 'Pausar'}
                className="relative flex h-[68px] w-[68px] items-center justify-center rounded-full text-white transition-transform active:scale-95"
                style={{
                  background:
                    'radial-gradient(circle at 50% 32%, rgba(79,70,229,0.55), rgba(15,23,42,0.92))',
                  border: '1.5px solid rgba(129,140,248,0.7)',
                }}
              >
                <span
                  className={`pointer-events-none absolute inset-0 rounded-full ${playing && !reducedMotion ? 'lap-glow-pulse' : ''}`}
                  style={{ boxShadow: '0 0 22px rgba(99,102,241,0.5)' }}
                />
                {showPlay ? (
                  <Play className="relative h-7 w-7 translate-x-0.5" />
                ) : (
                  <Pause className="relative h-7 w-7" />
                )}
              </button>
            </div>

            {/* Right — Reouvir (restart current block) */}
            <button
              onClick={onReplay}
              title={replayTitle}
              aria-label={replayAriaLabel}
              className="group absolute top-1/2 flex -translate-y-1/2 flex-col items-center gap-1"
              style={{ right: '8%' }}
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-full border border-slate-600/40 bg-slate-950/55 text-slate-300 backdrop-blur-sm transition-colors group-hover:border-indigo-400/50 group-hover:text-white group-active:scale-95">
                <RotateCcw className="h-4 w-4" />
              </span>
            </button>
          </>
        )}
      </div>

      {/* Mini-waveform + time labels */}
      <div className="w-full" style={{ maxWidth: CIRCLE_SIZE }}>
        <MiniWaveform seed={waveformSeed} progress={progress} />
        <div className="mt-1 flex justify-between text-xs tabular-nums text-slate-500">
          <span>{currentLabel}</span>
          <span>{durationLabel}</span>
        </div>
      </div>

      {/* Speed selector */}
      <div className="flex flex-wrap items-center justify-center gap-2">
        {speeds.map((s) => {
          const active = speed === s;
          return (
            <button
              key={s}
              onClick={() => onSelectSpeed(s)}
              aria-pressed={active}
              className={`min-w-[46px] rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                active
                  ? 'border border-indigo-300/60 bg-gradient-to-b from-indigo-500 to-purple-600 text-white shadow-[0_0_12px_rgba(139,92,246,0.4)]'
                  : 'border border-slate-700/60 bg-slate-800/70 text-slate-400 hover:bg-slate-700 hover:text-slate-200'
              }`}
            >
              {s === 1 ? '1×' : `${s}×`}
            </button>
          );
        })}
      </div>
    </div>
  );
}
