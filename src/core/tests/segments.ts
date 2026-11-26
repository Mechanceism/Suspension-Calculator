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
import { planAt, type SegmentPlan } from './plan';

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
  /** Coast: no throttle and no brakes; with the driver working the pedals the speed follows the forces (drag, grade, rolling resistance, bumps). */
  coast?: boolean;
  /** Road grade, rad (+ = uphill); with `gradeEnd`, the grade at its start. */
  grade: number;
  /**
   * A transition (round 5): the grade at its end, rad — the grade changes evenly along the segment from `grade` to
   * this (a vertical curve of radius distance ÷ (gradeEnd − grade)). Absent: one grade all along.
   */
  gradeEnd?: number;
  /** Road bank, rad (+ = left side lower). */
  bank: number;
  /** Ground height change under each wheel, mm (+ bump, − pothole). */
  bumps?: Partial<Record<CornerId, number>>;
  /** Speed samples across the range (1 when the speed is constant). */
  samples?: number;
  /** Rough surface and placed bumps / potholes along the segment. */
  road?: RoadSpec;
  /**
   * Speeds as maximums (plan.ts): the speeds planned along the segment (v₀ / v₁ are then the most it may go).
   * When set, the steady states, the ride over time and the playback follow it instead of v₀ → v₁.
   */
  plan?: SegmentPlan;
}

/** The road's grade at distance x along a segment, rad (a transition's changes evenly from start to end). */
export function gradeAlong(s: Pick<SegmentSpec, 'grade' | 'gradeEnd' | 'distance'>, x: number): number {
  if (s.gradeEnd === undefined || !(s.distance > 0)) return s.grade;
  return s.grade + (s.gradeEnd - s.grade) * Math.min(1, Math.max(0, x / s.distance));
}
/** The road's rise from a segment's start to distance x along it, m. */
export function heightAlong(s: Pick<SegmentSpec, 'grade' | 'gradeEnd' | 'distance'>, x: number): number {
  const k = vertCurvature(s);
  if (Math.abs(k) < 1e-12) return x * Math.sin(s.grade);
  const X = Math.min(Math.max(0, x), s.distance);
  // ∫ sin(γ₀ + k·t) dt over the curve, then straight on at its end grade.
  return (Math.cos(s.grade) - Math.cos(s.grade + k * X)) / k + Math.max(0, x - s.distance) * Math.sin(s.gradeEnd ?? s.grade);
}
/** A segment's vertical curvature, 1/m (+ = a dip, − = a crest; 0 for one grade). */
export function vertCurvature(s: Pick<SegmentSpec, 'grade' | 'gradeEnd' | 'distance'>): number {
  return s.gradeEnd === undefined || !(s.distance > 0) ? 0 : (s.gradeEnd - s.grade) / s.distance;
}

/**
 * Over a transition's crest at speed the tires can be left with almost no load (the car going light, or flying):
 * a steady state means nothing there and is skipped — the ride over time judges it (wheel lift, the landing).
 * True when the road's push on the car (in g, normal to it) is under LIGHT_G.
 */
export const LIGHT_G = 0.15;
const tooLight = (s: SegmentSpec, ay: number, ax: number, grade: number, v: number) => {
  const vertG = (v * v * vertCurvature(s)) / G;
  return vertG < 0 && Math.cos(s.bank) * Math.cos(grade) + ay * Math.sin(s.bank) - ax * Math.sin(grade) + vertG < LIGHT_G;
};

/** The speed at distance s along a segment (its plan, or v₀ → v₁ at constant acceleration). */
export function speedAlong(s: SegmentSpec, at: number): number {
  if (s.plan) return planAt(s.plan, at).v;
  const frac = s.distance > 0 ? Math.min(1, Math.max(0, at / s.distance)) : 0;
  return Math.sqrt(Math.max(0, s.v0 * s.v0 + (s.v1 * s.v1 - s.v0 * s.v0) * frac));
}
/** The fastest a segment goes. */
export const topSpeed = (s: SegmentSpec) => (s.plan ? Math.max(...s.plan.v) : Math.max(s.v0, s.v1));

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
export function roadEffective(ay: number, ax: number, grade: number, bank: number, vertG = 0) {
  const ct = Math.cos(bank), st = Math.sin(bank), cp = Math.cos(grade), sp = Math.sin(grade);
  const lateralG = ay * ct - st * cp;
  const along = ax * cp + sp;
  // vertG: the path's own vertical acceleration, g (u²·κ over a transition: + in a dip, − over a crest — the car
  // goes light there, round 5).
  const normal = Math.max(0.05, ct * cp + ay * st - ax * sp + vertG);
  return { lateralG, accelG: Math.max(0, along), brakingG: Math.max(0, -along), gravityScale: normal };
}

/** Steady states of one segment (speeds scaled by `speedScale`, e.g. for a speed-limit search). */
export function segmentStates(s: SegmentSpec, index: number, speedScale = 1, dims?: CarDims): RoadState[] {
  if (s.plan && s.plan.s.length > 1) return planStates(s, index, dims);
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
    // (A transition: the grade where this sample is — along the segment as its speed is — and the curve's lift.)
    const x = n === 1 ? s.distance / 2 : (s.distance * i) / (n - 1);
    const gr = gradeAlong(s, x);
    if (tooLight(s, ay, ax, gr, v)) continue;
    const eff = roadEffective(ay, ax, gr, s.bank, (v * v * vertCurvature(s)) / G);
    out.push({
      name: `${index + 1}${n > 1 ? `.${i + 1}` : ''}`, segment: index, speed: v, ay, ax,
      ...eff, groundOffset: { ...(s.bumps ?? {}) }, grade: gr, bank: s.bank,
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
      if (tooLight(s, ay, ax, gradeAlong(s, at), v)) return;
      const h = wheelHeights(s.road!, at, wb, ht);
      const ground: Partial<Record<CornerId, number>> = {};
      for (const id of ['FL', 'FR', 'RL', 'RR'] as CornerId[]) {
        const v2 = (s.bumps?.[id] ?? 0) + h[id];
        if (Math.abs(v2) > 1e-6) ground[id] = v2;
      }
      out.push({
        name: `${index + 1}.r${k + 1}`, segment: index, speed: v, ay, ax, at,
        ...roadEffective(ay, ax, gradeAlong(s, at), s.bank, (v * v * vertCurvature(s)) / G), groundOffset: ground, grade: gradeAlong(s, at), bank: s.bank,
      });
    });
  }
  return out;
}

/**
 * Steady states of a planned segment: its fastest and slowest points and where it brakes and drives hardest
 * (each at the speed and acceleration planned there), plus the rough road's worst spots at the planned speed.
 */
function planStates(s: SegmentSpec, index: number, dims?: CarDims): RoadState[] {
  const pl = s.plan!;
  const at = pl.s.map((x) => ({ x, ...planAt(pl, Math.min(x + 1e-6, s.distance)) }));
  const pick = new Map<number, (typeof at)[number]>();
  const by = (f: (p: (typeof at)[number]) => number) => at.reduce((a, p) => (f(p) > f(a) ? p : a), at[0]!);
  for (const p of [by((p) => p.v), by((p) => -p.v), by((p) => -p.a), by((p) => p.a)]) pick.set(Math.round(p.x * 10), p);
  const out: RoadState[] = [];
  let k = 0;
  for (const p of [...pick.values()].sort((a, b) => a.x - b.x)) {
    const ay = segmentLatG(s, p.v), ax = Math.abs(p.a) > 1e-6 ? p.a / G : 0;
    if (tooLight(s, ay, ax, gradeAlong(s, p.x), p.v)) continue;
    out.push({ name: `${index + 1}.${++k}`, segment: index, speed: p.v, ay, ax, at: p.x, ...roadEffective(ay, ax, gradeAlong(s, p.x), s.bank, (p.v * p.v * vertCurvature(s)) / G), groundOffset: { ...(s.bumps ?? {}) }, grade: gradeAlong(s, p.x), bank: s.bank });
  }
  if (dims && s.road) {
    const wb = dims.wheelbase / 1000, ht = dims.halfTrack / 1000;
    worstRoadSpots(s.road, s.distance, wb, ht).forEach((x, j) => {
      const q = planAt(pl, x);
      const ay = segmentLatG(s, q.v), ax = q.a / G;
      if (tooLight(s, ay, ax, gradeAlong(s, x), q.v)) return;
      const h = wheelHeights(s.road!, x, wb, ht);
      const ground: Partial<Record<CornerId, number>> = {};
      for (const id of ['FL', 'FR', 'RL', 'RR'] as CornerId[]) {
        const v2 = (s.bumps?.[id] ?? 0) + h[id];
        if (Math.abs(v2) > 1e-6) ground[id] = v2;
      }
      out.push({ name: `${index + 1}.r${j + 1}`, segment: index, speed: q.v, ay, ax, at: x, ...roadEffective(ay, ax, gradeAlong(s, x), s.bank, (q.v * q.v * vertCurvature(s)) / G), groundOffset: ground, grade: gradeAlong(s, x), bank: s.bank });
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

/**
 * The racing line through a constant-radius turn (radius R along the centerline, arc length, usable track
 * width w; m): the classic constant-radius line, in from the outside edge of the straight (tangent to it),
 * touching the inside edge at the apex (mid-turn), out to the outside edge of the next straight. With
 * θ = arc length ÷ R and c = cos(θ/2), the arc tangent to both outside edges and touching the inside one:
 *   ρ = R + (w/2)(1 + c)/(1 − c)          (e.g. 90°, R 20 m, w 8 m → 43 m)
 * w ≤ 0: R.
 */
export function racingLineRadius(R: number, arcLength: number, w: number): number {
  if (!(w > 0) || !(R > 0)) return R;
  const c = Math.cos(Math.min(arcLength / R, Math.PI * 0.999) / 2);
  return R + (w / 2) * (1 + c) / Math.max(1 - c, 1e-9);
}
