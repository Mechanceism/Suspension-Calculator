/**
 * Test segments (Phase A, quasi-static): each segment combines three layers that act at the same time:
 *   speed: start → end speed over a distance (acceleration = (v₁² − v₀²) / 2d), or a g override
 *   path:  straight, or a left / right turn of radius R (lateral g = v² / (g·R)), or a lateral-g override
 *   road:  grade (incline / decline), bank, and bumps / potholes under chosen wheels
 * A test is a chain of segments. Each segment is sampled at a few speeds across its range; every sample
 * is one steady state for the whole-car solve. (Order along the chain doesn't change steady states;
 * transients come with the time-based Phase B.)
 *
 * Grade and bank tilt gravity in the road frame (roadEffective): the tires must also supply m·g·sin(grade)
 * along the road (uphill needs drive), across it m·(a_y·cos(bank) − g·sin(bank)) (a bank toward the inside
 * of the turn helps), and turning on a bank also presses the car into the road.
 */
import type { CornerId } from '../vehicle/vehicle';
import type { CheckProfile } from './checks';
import { wheelHeights, worstRoadSpots, type RoadSpec } from './road';

export const G = 9.80665;

export type PathKind = 'straight' | 'left' | 'right';

export interface SegmentSpec {
  name?: string;
  /** Segment length, m. */
  distance: number;
  /** Speeds at the start and end, m/s. */
  v0: number;
  v1: number;
  path: PathKind;
  /** Turn radius, m (turns only). */
  radius: number;
  /** Lateral acceleration override, g (magnitude; the turn direction sets the sign). */
  latG?: number | null;
  /** Longitudinal acceleration override, g (+ accelerating, − braking). */
  longG?: number | null;
  /** Road grade, rad (+ = uphill). */
  grade: number;
  /** Road bank, rad (+ = left side lower). */
  bank: number;
  /** Ground height change under each wheel, mm (+ bump, − pothole). */
  bumps?: Partial<Record<CornerId, number>>;
  /** Speed samples across the range (1 when the speed is constant). */
  samples?: number;
  /** Rough surface and placed bumps / potholes along the segment. */
  road?: RoadSpec;
}

/** Car dimensions needed to put the wheels on the road. */
export interface CarDims { wheelbase: number; halfTrack: number }

/** One steady state to solve. Accelerations are the road-frame values the tires must supply. */
export interface RoadState {
  /** Label, e.g. "2: 45 mph". */
  name: string;
  segment: number;
  /** Speed of this sample, m/s. */
  speed: number;
  /** Kinematic accelerations of the car (g): lateral (+ left), longitudinal (+ forward). */
  ay: number;
  ax: number;
  /** What the solver needs: effective lateral g, braking / accel g, gravity scale, ground offsets. */
  lateralG: number;
  brakingG: number;
  accelG: number;
  gravityScale: number;
  groundOffset: Partial<Record<CornerId, number>>;
  /** Road grade and bank, rad (to show the state again). */
  grade: number;
  bank: number;
  /** Position along the segment, m (road-surface states). */
  at?: number;
  /** Rack travel for the turn, mm (left corner's rack; clamped to the limit). */
  rack?: number;
  /** Optimizer weight (test priority × segment weight) and the pass rules that apply. */
  weight?: number;
  checks?: CheckProfile;
}

/** Longitudinal acceleration of a segment, g (+ accelerating). */
export function segmentLongG(s: SegmentSpec): number {
  if (s.longG !== null && s.longG !== undefined && Number.isFinite(s.longG)) return s.longG;
  if (!(s.distance > 0)) return 0;
  return (s.v1 * s.v1 - s.v0 * s.v0) / (2 * s.distance) / G;
}

/** Lateral acceleration at speed v, g (+ = left turn). */
export function segmentLatG(s: SegmentSpec, v: number): number {
  if (s.path === 'straight') return 0;
  const sign = s.path === 'left' ? 1 : -1;
  if (s.latG !== null && s.latG !== undefined && Number.isFinite(s.latG)) return sign * Math.abs(s.latG);
  return s.radius > 0 ? (sign * v * v) / (G * s.radius) : 0;
}

/**
 * Fold grade and bank into what the solver needs: the car's acceleration and gravity resolved in the road
 * plane (in g). With bank θ (+ = left side lower) and grade φ (+ = uphill):
 *   lateral (across the road)  = a_y·cos θ − sin θ·cos φ
 *   along the road             = a_x·cos φ + sin φ
 *   normal (pressing the car on the road) = cos θ·cos φ + a_y·sin θ − a_x·sin φ
 * so turning on a bank toward the inside both needs less side grip and pushes the car into the road.
 */
export function roadEffective(ay: number, ax: number, grade: number, bank: number) {
  const ct = Math.cos(bank), st = Math.sin(bank), cp = Math.cos(grade), sp = Math.sin(grade);
  const lateralG = ay * ct - st * cp;
  const along = ax * cp + sp;
  const normal = Math.max(0.05, ct * cp + ay * st - ax * sp);
  return { lateralG, accelG: Math.max(0, along), brakingG: Math.max(0, -along), gravityScale: normal };
}

/** Steady states of one segment (speeds scaled by `speedScale`, e.g. for a speed-limit search). */
export function segmentStates(s: SegmentSpec, index: number, speedScale = 1, dims?: CarDims): RoadState[] {
  const v0 = s.v0 * speedScale, v1 = s.v1 * speedScale;
  const n = Math.abs(v1 - v0) < 1e-9 ? 1 : Math.max(2, Math.round(s.samples ?? 3));
  const scaled: SegmentSpec = { ...s, v0, v1 };
  // A g override scales with speed² so a speed-limit search still means something.
  if (scaled.longG !== null && scaled.longG !== undefined && Number.isFinite(scaled.longG)) scaled.longG *= speedScale * speedScale;
  const ax = segmentLongG(scaled);
  const out: RoadState[] = [];
  for (let i = 0; i < n; i++) {
    const v = n === 1 ? v0 : v0 + ((v1 - v0) * i) / (n - 1);
    let ay = segmentLatG(scaled, v);
    if (s.latG !== null && s.latG !== undefined && Number.isFinite(s.latG)) ay *= speedScale * speedScale;
    const eff = roadEffective(ay, ax, s.grade, s.bank);
    out.push({
      name: `${index + 1}${n > 1 ? `.${i + 1}` : ''}`, segment: index, speed: v, ay, ax,
      ...eff, groundOffset: { ...(s.bumps ?? {}) }, grade: s.grade, bank: s.bank,
    });
  }
  // Rough road / bumps: the worst spots along the segment, at the speed the car has there.
  if (dims && s.road) {
    const wb = dims.wheelbase / 1000, ht = dims.halfTrack / 1000;
    worstRoadSpots(s.road, s.distance, wb, ht).forEach((at, k) => {
      const frac = s.distance > 0 ? Math.min(1, at / s.distance) : 0;
      const v = Math.sqrt(Math.max(0, v0 * v0 + (v1 * v1 - v0 * v0) * frac));
      let ay = segmentLatG(scaled, v);
      if (s.latG !== null && s.latG !== undefined && Number.isFinite(s.latG)) ay *= speedScale * speedScale;
      const h = wheelHeights(s.road!, at, wb, ht);
      const ground: Partial<Record<CornerId, number>> = {};
      for (const id of ['FL', 'FR', 'RL', 'RR'] as CornerId[]) {
        const v2 = (s.bumps?.[id] ?? 0) + h[id];
        if (Math.abs(v2) > 1e-6) ground[id] = v2;
      }
      out.push({
        name: `${index + 1}.r${k + 1}`, segment: index, speed: v, ay, ax, at,
        ...roadEffective(ay, ax, s.grade, s.bank), groundOffset: ground, grade: s.grade, bank: s.bank,
      });
    });
  }
  return out;
}

export const testStates = (segments: SegmentSpec[], dims?: CarDims): RoadState[] => segments.flatMap((s, i) => segmentStates(s, i, 1, dims));

/** A point on the track (top view), m, and the heading, rad (0 = +x, + = left). */
export interface TrackPoint { x: number; y: number; heading: number }

/**
 * The track drawn from the segments alone (top view): straights and arcs of the turn radius, chained.
 * One polyline per segment, each starting where the previous one ended.
 */
export function trackPath(segs: Pick<SegmentSpec, 'distance' | 'path' | 'radius'>[], maxStep = 2): TrackPoint[][] {
  let x = 0, y = 0, heading = 0;
  return segs.map((s) => {
    const pts: TrackPoint[] = [{ x, y, heading }];
    const d = Math.max(0, s.distance);
    const curv = s.path === 'straight' ? 0 : (s.path === 'left' ? 1 : -1) / Math.max(s.radius, 0.1);
    // Arcs: at most ~10° per step so they look round.
    const step = curv ? Math.min(maxStep, (10 * Math.PI) / 180 / Math.abs(curv)) : d;
    const n = Math.max(1, Math.ceil(d / Math.max(step, 1e-6)));
    const x0 = x, y0 = y, h0 = heading;
    for (let i = 1; i <= n; i++) {
      const sAlong = (d * i) / n;
      if (curv) {
        heading = h0 + curv * sAlong;
        x = x0 + (Math.sin(heading) - Math.sin(h0)) / curv;
        y = y0 - (Math.cos(heading) - Math.cos(h0)) / curv;
      } else {
        x = x0 + sAlong * Math.cos(h0);
        y = y0 + sAlong * Math.sin(h0);
      }
      pts.push({ x, y, heading });
    }
    return pts;
  });
}

/** Segment duration, s (constant acceleration over the distance). */
export function segmentDuration(s: SegmentSpec): number {
  const v = (s.v0 + s.v1) / 2;
  return v > 0 ? s.distance / v : Infinity;
}
