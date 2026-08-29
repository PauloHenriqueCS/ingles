/**
 * CAMADA B — real circular progress.
 *
 * A base ring (low opacity) with a gradient (blue → purple) progress arc drawn
 * on top via stroke-dasharray/stroke-dashoffset, plus a luminous dot riding the
 * arc's leading edge. Everything is derived from the REAL audio progress
 * (0..1) passed in — this is a visual indicator only; it does NOT add any
 * seek-by-drag behaviour that the player doesn't already have.
 */
interface Props {
  /** Audio progress, 0..1 (currentTime / duration). */
  progress: number;
}

const R = 46; // circle radius within the 100×100 viewBox
const CIRCUMFERENCE = 2 * Math.PI * R;

export default function CircularAudioProgress({ progress }: Props) {
  const p = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  const dashOffset = CIRCUMFERENCE * (1 - p);

  // Leading-edge dot position. -π/2 puts progress start at 12 o'clock, matching
  // the ring (which is rotated -90° so its dash also starts at the top).
  const angle = p * 2 * Math.PI - Math.PI / 2;
  const dotX = 50 + R * Math.cos(angle);
  const dotY = 50 + R * Math.sin(angle);

  return (
    <svg
      viewBox="0 0 100 100"
      className="absolute inset-0 h-full w-full overflow-visible"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="lap-progress-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#3b82f6" />
          <stop offset="55%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#a855f7" />
        </linearGradient>
      </defs>

      {/* Base ring */}
      <circle
        cx="50"
        cy="50"
        r={R}
        fill="none"
        stroke="rgba(148,163,184,0.14)"
        strokeWidth="1.4"
      />

      {/* Progress arc */}
      <circle
        cx="50"
        cy="50"
        r={R}
        fill="none"
        stroke="url(#lap-progress-grad)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={dashOffset}
        transform="rotate(-90 50 50)"
        style={{ transition: 'stroke-dashoffset 0.18s linear' }}
      />

      {/* Luminous progress dot (only once playback has actually started) */}
      {p > 0.0005 && (
        <g style={{ transition: 'transform 0.18s linear' }}>
          <circle cx={dotX} cy={dotY} r={3.6} fill="#60a5fa" opacity={0.35} />
          <circle cx={dotX} cy={dotY} r={2} fill="#c7d2fe" opacity={0.85} />
          <circle cx={dotX} cy={dotY} r={0.9} fill="#f8fafc" />
        </g>
      )}
    </svg>
  );
}
