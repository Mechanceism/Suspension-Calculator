/**
 * Road surface for test segments: a seeded random height map (rough / lumpy road) plus placed bumps and
 * potholes. Heights are in mm, positions in m: s along the segment (from its start), y across the road
 * (+ = left of the car's center line).
 *
 * Height map: smooth value noise (3 octaves) of feature size `scale`, limited to rough patches by a
 * second, coarser noise (`coverage` = share of the road that is rough), times `maxHeight`. The same seed
 * always gives the same road.
 */
import type { CornerId } from '../vehicle/vehicle';

export interface RoughSurface {
  seed: number;
  /** Largest bump height / pothole depth, mm. */
  maxHeight: number;
  /** Typical bump size and spacing, m (smaller = more, closer bumps). */
  scale: number;
  /** Share of the road that is rough, 0–1. */
  coverage: number;
}

export interface RoadFeature {
  kind: 'bump' | 'pothole';
  /** Start, m from the segment start. */
  at: number;
  /** Length along the road, m. */
  length: number;
  /** Height (bump) or depth (pothole), mm (positive). */
  height: number;
  /** Which wheel track it is under. */
  side: 'left' | 'right' | 'both';
}

/** 32-bit hash of a lattice point and a seed → [0, 1). */
function hash(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Smooth value noise in [-1, 1]. */
function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = smooth(x - ix), fy = smooth(y - iy);
  const v = (i: number, j: number) => hash(ix + i, iy + j, seed) * 2 - 1;
  const a = v(0, 0) + (v(1, 0) - v(0, 0)) * fx;
  const b = v(0, 1) + (v(1, 1) - v(0, 1)) * fx;
  return a + (b - a) * fy;
}

/** Rough-surface height, mm, at (s, y) in m. */
export function roughHeight(r: RoughSurface, s: number, y: number): number {
  if (!(r.maxHeight > 0) || !(r.scale > 0)) return 0;
  const x = s / r.scale, z = y / r.scale;
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < 3; o++) {
    sum += amp * valueNoise(x * f, z * f, r.seed + o * 101);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  const base = sum / norm / 0.6; // value noise rarely reaches ±1: stretch so peaks reach about maxHeight
  // Rough patches: coarse noise above a threshold set by the coverage (1 = everywhere).
  const cov = Math.min(1, Math.max(0, r.coverage));
  const mask = cov >= 0.999 ? 1 : Math.min(1, Math.max(0, ((valueNoise(x / 4, z / 4, r.seed + 977) * 0.5 + 0.5) - (1 - cov)) / 0.15));
  return Math.max(-1, Math.min(1, base)) * r.maxHeight * mask;
}

/** Height of placed features at (s, y), mm. */
export function featureHeight(fs: RoadFeature[], s: number, y: number): number {
  let h = 0;
  for (const f of fs) {
    if (!(f.length > 0) || s < f.at || s > f.at + f.length) continue;
    if (f.side === 'left' && y < 0) continue;
    if (f.side === 'right' && y > 0) continue;
    const u = (s - f.at) / f.length;
    h += (f.kind === 'bump' ? 1 : -1) * f.height * (1 - Math.cos(2 * Math.PI * u)) / 2;
  }
  return h;
}

export interface RoadSpec { rough?: RoughSurface | null; features?: RoadFeature[] }

export const roadHeight = (r: RoadSpec, s: number, y: number) =>
  (r.rough ? roughHeight(r.rough, s, y) : 0) + featureHeight(r.features ?? [], s, y);

/**
 * Ground height under each wheel with the front axle at s (m along the segment). Rear wheels are a
 * wheelbase behind (if that is before the segment start, they're on the previous road: taken as flat).
 */
export function wheelHeights(r: RoadSpec, s: number, wheelbase: number, halfTrack: number): Record<CornerId, number> {
  const rear = s - wheelbase;
  const at = (ss: number, y: number) => (ss < 0 ? 0 : roadHeight(r, ss, y));
  return { FL: at(s, halfTrack), FR: at(s, -halfTrack), RL: at(rear, halfTrack), RR: at(rear, -halfTrack) };
}

/**
 * Positions along a segment worth checking as steady states: the highest and lowest wheel and the
 * largest diagonal twist (warp), scanning every 0.1 m. Empty for a smooth road.
 */
export function worstRoadSpots(r: RoadSpec, length: number, wheelbase: number, halfTrack: number): number[] {
  if (!r.rough && !(r.features?.length)) return [];
  let best = { up: { s: 0, v: 0 }, down: { s: 0, v: 0 }, warp: { s: 0, v: 0 } };
  for (let s = 0; s <= length + wheelbase; s += 0.1) {
    const h = wheelHeights(r, s, wheelbase, halfTrack);
    const vals = Object.values(h);
    const up = Math.max(...vals), down = -Math.min(...vals);
    const warp = Math.abs((h.FL + h.RR) - (h.FR + h.RL));
    if (up > best.up.v) best = { ...best, up: { s, v: up } };
    if (down > best.down.v) best = { ...best, down: { s, v: down } };
    if (warp > best.warp.v) best = { ...best, warp: { s, v: warp } };
  }
  return [...new Set([best.up, best.down, best.warp].filter((x) => x.v > 0.5).map((x) => Number(x.s.toFixed(1))))];
}
