/**
 * In-house generator for the two celebration Lottie animations. Authored by us
 * for Orodim (no third-party source) → license is 100% ours, commercial-safe.
 * Run: `node src/celebration/assets/lottie/generate.mjs` → writes
 * activity-complete.json and day-complete.json next to this file.
 *
 * The output is standard Bodymovin JSON rendered by the real Lottie runtime
 * (lottie-web via lottie-react). Kept as a generator so scale/timing/colours are
 * tweakable and the provenance is self-evident.
 */
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FR = 60; // fps

// ── keyframe helpers ────────────────────────────────────────────────────────
const EASE_OUT = { i: { x: [0.16], y: [1] }, o: { x: [0.3], y: [0] } };
const EASE_IN_OUT = { i: { x: [0.42], y: [1] }, o: { x: [0.58], y: [0] } };
const EASE_OUT_N = (n) => ({ i: { x: Array(n).fill(0.16), y: Array(n).fill(1) }, o: { x: Array(n).fill(0.3), y: Array(n).fill(0) } });
const EASE_INOUT_N = (n) => ({ i: { x: Array(n).fill(0.42), y: Array(n).fill(1) }, o: { x: Array(n).fill(0.58), y: Array(n).fill(0) } });

/** Animated scalar (opacity/trim). stops = [[t, value], ...] */
function scalar(stops, ease = EASE_IN_OUT) {
  if (stops.length === 1) return { a: 0, k: stops[0][1] };
  return {
    a: 1,
    k: stops.map(([t, v], idx) => (idx === stops.length - 1 ? { t, s: [v] } : { t, s: [v], ...ease })),
  };
}
/** Animated multi-dim value (scale [x,y,z] / position [x,y,z]). */
function vec(stops, dims = 3, ease = EASE_INOUT_N) {
  if (stops.length === 1) return { a: 0, k: stops[0][1] };
  const e = ease(dims);
  return { a: 1, k: stops.map(([t, v], idx) => (idx === stops.length - 1 ? { t, s: v } : { t, s: v, ...e })) };
}
const still = (k) => ({ a: 0, k });

// ── shape builders ──────────────────────────────────────────────────────────
const tr = (opts = {}) => ({
  ty: 'tr',
  p: opts.p ?? still([0, 0]),
  a: opts.a ?? still([0, 0]),
  s: opts.s ?? still([100, 100]),
  r: opts.r ?? still(0),
  o: opts.o ?? still(100),
});
const ellipse = (size) => ({ ty: 'el', p: still([0, 0]), s: still([size, size]) });
const fill = (rgba) => ({ ty: 'fl', c: still(rgba), o: still(100) });
const stroke = (rgba, w) => ({ ty: 'st', c: still(rgba), o: still(100), w: still(w), lc: 2, lj: 2 });
const rect = (w, h, r = 0) => ({ ty: 'rc', p: still([0, 0]), s: still([w, h]), r: still(r) });
const star = (points, outer, inner) => ({
  ty: 'sr', sy: 1, p: still([0, 0]), or: still(outer), ir: still(inner),
  os: still(0), is: still(0), r: still(0), pt: still(points),
});
const radialGrad = (size, stops) => ({
  ty: 'gf', o: still(100), r: 1, t: 2,
  s: still([0, 0]), e: still([size / 2, 0]),
  g: { p: stops.length / 4, k: still(stops) },
});
const path = (verts, closed = false) => ({
  ty: 'sh',
  ks: still({ i: verts.map(() => [0, 0]), o: verts.map(() => [0, 0]), v: verts, c: closed }),
});
const trim = (endStops, ease) => ({ ty: 'tm', s: still(0), e: scalar(endStops, ease), o: still(0), m: 1 });
const group = (items) => ({ ty: 'gr', it: items });

function layer(nm, shapes, ks, op) {
  return { ddd: 0, ind: layer._i++, ty: 4, nm, sr: 1, ao: 0, ks, shapes, ip: 0, op, st: 0, bm: 0 };
}
function comp(nm, w, h, op, layers) {
  layer._i = 1;
  return { v: '5.7.4', fr: FR, ip: 0, op, w, h, nm, ddd: 0, assets: [], layers };
}

const KS = (p, opts = {}) => ({
  o: opts.o ?? still(100), r: opts.r ?? still(0), p: still([...p, 0]),
  a: opts.a ?? still([0, 0, 0]), s: opts.s ?? still([100, 100, 100]),
});

// palette (0..1 rgba)
const EMERALD = [0.06, 0.725, 0.51, 1];
const TEAL = [0.078, 0.722, 0.651, 1];
const WHITE = [1, 1, 1, 1];
const AMBER = [0.96, 0.62, 0.04, 1];
const ORANGE = [0.98, 0.45, 0.09, 1];
const CONFETTI = [EMERALD, AMBER, [0.22, 0.74, 0.98, 1], [0.655, 0.545, 0.98, 1], [0.96, 0.45, 0.71, 1]];

// ── ACTIVITY (300x300, ~60 frames = 1s of Lottie content) ───────────────────
function activity() {
  const C = [150, 150];
  const layers = [];

  // glow (radial amber-free emerald), scales out + fades
  layers.push(layer('glow', [group([
    ellipse(220),
    radialGrad(220, [0, EMERALD[0], EMERALD[1], EMERALD[2], 1, EMERALD[0], EMERALD[1], EMERALD[2]]),
    tr(),
  ])], {
    ...KS(C, {
      o: scalar([[0, 0], [12, 55], [40, 0]], EASE_OUT),
      s: vec([[0, [40, 40, 100]], [20, [110, 110, 100]], [40, [135, 135, 100]]]),
    }),
  }, 60));

  // main disc, spring scale-in with overshoot
  layers.push(layer('disc', [group([ellipse(120), fill(EMERALD), tr()])], {
    ...KS(C, {
      s: vec([[0, [0, 0, 100]], [14, [116, 116, 100]], [26, [96, 96, 100]], [34, [100, 100, 100]]], 3, EASE_OUT_N),
      o: scalar([[0, 0], [6, 100]], EASE_OUT),
    }),
  }, 60));

  // check stroke, draws in after the disc lands
  layers.push(layer('check', [group([
    path([[-26, 4], [-8, 22], [28, -18]], false),
    stroke(WHITE, 12),
    trim([[16, 0], [34, 100]], EASE_OUT),
    tr(),
  ])], { ...KS(C) }, 60));

  // sparkles bursting outward
  const N = 7;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const r0 = 62, r1 = 108 + (i % 3) * 10;
    const p0 = [C[0] + Math.cos(a) * r0, C[1] + Math.sin(a) * r0];
    const p1 = [C[0] + Math.cos(a) * r1, C[1] + Math.sin(a) * r1];
    const d = 18 + (i % 4) * 2;
    layers.push(layer(`sparkle${i}`, [group([ellipse(9), fill(i % 2 ? WHITE : TEAL), tr()])], {
      ...KS([0, 0], {}),
      p: vec([[d, [...p0, 0]], [d + 22, [...p1, 0]]], 3, EASE_OUT_N),
      o: scalar([[d, 0], [d + 6, 100], [d + 28, 0]], EASE_OUT),
      s: vec([[d, [30, 30, 100]], [d + 10, [100, 100, 100]], [d + 28, [40, 40, 100]]]),
    }, 60));
  }
  return comp('activity-complete', 300, 300, 60, layers);
}

// ── DAY COMPLETE (400x400, ~110 frames) ─────────────────────────────────────
function day() {
  const C = [200, 200];
  const layers = [];

  layers.push(layer('glow', [group([
    ellipse(320),
    radialGrad(320, [0, AMBER[0], AMBER[1], AMBER[2], 1, ORANGE[0], ORANGE[1], ORANGE[2]]),
    tr(),
  ])], {
    ...KS(C, {
      o: scalar([[0, 0], [16, 60], [70, 20], [100, 0]], EASE_OUT),
      s: vec([[0, [40, 40, 100]], [30, [120, 120, 100]], [100, [150, 150, 100]]]),
    }),
  }, 110));

  // rotating burst ring of thin rays
  const rays = [];
  const R = 12;
  for (let i = 0; i < R; i++) {
    rays.push(group([
      rect(6, 46, 3),
      fill(AMBER),
      tr({ p: still([0, -120]), r: still((i / R) * 360) }),
    ]));
  }
  layers.push(layer('rays', rays, {
    ...KS(C, {
      o: scalar([[6, 0], [22, 70], [55, 0]], EASE_OUT),
      s: vec([[6, [30, 30, 100]], [30, [110, 110, 100]]]),
      r: scalar([[6, 0], [60, 40]], EASE_OUT),
    }),
  }, 110));

  // main disc
  layers.push(layer('disc', [group([ellipse(150), fill(ORANGE), tr()])], {
    ...KS(C, {
      s: vec([[0, [0, 0, 100]], [20, [118, 118, 100]], [34, [94, 94, 100]], [46, [100, 100, 100]]], 3, EASE_OUT_N),
      o: scalar([[0, 0], [8, 100]], EASE_OUT),
    }),
  }, 110));

  // central star pop
  layers.push(layer('star', [group([star(5, 46, 22), fill(WHITE), tr()])], {
    ...KS(C, {
      s: vec([[14, [0, 0, 100]], [30, [120, 120, 100]], [42, [100, 100, 100]]], 3, EASE_OUT_N),
      r: scalar([[14, -30], [46, 0]], EASE_OUT),
      o: scalar([[14, 0], [22, 100]], EASE_OUT),
    }),
  }, 110));

  // confetti burst + gentle fall
  const N = 16;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const r0 = 70, r1 = 150 + (i % 4) * 16;
    const p0 = [C[0] + Math.cos(a) * r0, C[1] + Math.sin(a) * r0];
    const p1 = [C[0] + Math.cos(a) * r1, C[1] + Math.sin(a) * r1 + 26];
    const d = 20 + (i % 6) * 2;
    const col = CONFETTI[i % CONFETTI.length];
    layers.push(layer(`confetti${i}`, [group([rect(10, 16, 2), fill(col), tr({ r: still((i * 37) % 360) })])], {
      ...KS([0, 0], {}),
      p: vec([[d, [...p0, 0]], [d + 46, [...p1, 0]]], 3, EASE_OUT_N),
      r: scalar([[d, 0], [d + 46, (i % 2 ? 1 : -1) * (160 + (i % 3) * 40)]], EASE_OUT),
      o: scalar([[d, 0], [d + 8, 100], [d + 60, 0]], EASE_OUT),
      s: vec([[d, [50, 50, 100]], [d + 12, [100, 100, 100]]]),
    }, 110));
  }
  return comp('day-complete', 400, 400, 110, layers);
}

writeFileSync(join(HERE, 'activity-complete.json'), JSON.stringify(activity()));
writeFileSync(join(HERE, 'day-complete.json'), JSON.stringify(day()));
console.log('wrote activity-complete.json + day-complete.json');
