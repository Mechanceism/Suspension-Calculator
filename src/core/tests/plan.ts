/**
 * Speeds as maximums (user review 4, U4e): plan the speed along a whole test from what the car can do at a
 * grip target, never above a segment's set speeds.
 *
 * The car's limits at the grip target t (a share of the tires' peak grip, default 95 %):
 *   cornering   a_y ≤ t · min(μ_front, μ_rear) · g   (bank helps: v² ≤ g (a_y,max + sign(κ) sin θ) / (|κ| cos θ))
 *   braking     each braked axle carries its share of the braking (the bias) within its grip, with the load
 *               moving forward by x·h/L: front β x ≤ t μ_f (f + x h/L), rear (1 − β) x ≤ t μ_r (r − x h/L), and
 *               within the brake system's force per axle (when modeled)
 *   driving     the driven axles (split d to the front): d x ≤ t μ_f (f − x h/L), (1 − d) x ≤ t μ_r (r + x h/L)
 * with f, r the static load shares and x in g. Braking and driving share each axle's tires with its cornering
 * (combinedLimit: the grip ellipse at the axle's load after the weight transfer); grade and rolling
 * resistance add or take away.
 * The profile v(s) on a ≈ 1 m grid: v ≤ the set speed (each segment's v₀ → v₁, as maximums) and the cornering
 * speed; a forward pass accelerates as the drive allows, a backward pass brakes as the brakes allow, so the car
 * brakes **earlier** (in the segments before) to arrive at what a turn or a braking segment needs.
 *
 * Shapes (the driver's ways of taking a segment, tried in turn when one fails over time): the plan as above
 * (brake before, hold, accelerate out); brake in / accelerate out (no throttle in the first half); coast in /
 * accelerate out (no pedals in the first half); hold the segment's lowest speed throughout; speed up in /
 * slow down out (lower at the ends, its lowest speed at the middle).
 */
import { G, type SegmentSpec } from './segments';

/** What the car can do (from its static grip). */
export interface PlanCar {
  /** Peak side grip ÷ load per axle at static (the tire model, load sensitivity included). */
  muFront: number;
  muRear: number;
  /** Peak braking / driving grip ÷ load per axle (default: the side grip). */
  muLongFront?: number;
  muLongRear?: number;
  /** Static front load share (0–1), CG height and wheelbase (mm). */
  frontShare: number;
  cgHeight: number;
  wheelbase: number;
  /** Track (mm): cornering moves load to the outside wheels (the inside one locks / spins first). */
  track?: number;
  /** Front shares of the braking and of the drive (0–1). */
  brakeBias: number;
  driveSplit: number;
  brakesFront: boolean;
  brakesRear: boolean;
  drivenFront: boolean;
  drivenRear: boolean;
  /** Brake system: the most braking force per axle (N), when modeled. */
  brakeForce?: { front: number; rear: number };
  mass: number;
  rollingResistance?: number;
  /** Powertrain (F5): the most force it pushes the car with at speed v (m/s), N. None: only the tires limit the drive. */
  drive?: (v: number) => number;
  /** Aero drag ÷ speed², N/(m/s)² (½ ρ CdA; 0 / none = no drag). */
  dragArea?: number;
  /**
   * Side grip ÷ load per axle measured in turns of these radii (m, ascending) at the planned push — e.g. a
   * locked axle scrubs more in a tight turn. Between them by curvature, beyond them the nearest; none: the
   * constant `muFront` / `muRear`.
   */
  lateralAt?: { radius: number; front: number; rear: number }[];
}

/** Each axle's side grip ÷ load in a turn of curvature `kappa` (1/m; 0 = straight). */
export function lateralMu(car: PlanCar, kappa = 0): { front: number; rear: number } {
  const t = car.lateralAt;
  const k = Math.abs(kappa);
  if (!t?.length || k < 1e-9) return { front: car.muFront, rear: car.muRear };
  // By curvature: the widest turn (smallest 1/R) last.
  const pts = t.map((x) => ({ k: 1 / x.radius, front: x.front, rear: x.rear })).sort((a, b) => a.k - b.k);
  if (k <= pts[0]!.k) return { front: pts[0]!.front, rear: pts[0]!.rear };
  const last = pts[pts.length - 1]!;
  if (k >= last.k) return { front: last.front, rear: last.rear };
  let i = 0;
  while (i + 1 < pts.length && pts[i + 1]!.k < k) i++;
  const a = pts[i]!, b = pts[i + 1]!, u = (k - a.k) / (b.k - a.k);
  return { front: a.front + (b.front - a.front) * u, rear: a.rear + (b.rear - a.rear) * u };
}

export type PlanShape = 'plan' | 'brakeIn' | 'coastIn' | 'hold' | 'accelIn';

export interface PlanOptions {
  /**
   * Grip only (round 4, F6): the segments' set speeds aren't caps — the turns, braking and accelerating are
   * limited by the grip alone, the straights by `topSpeed` (m/s; until a powertrain limits them). The test
   * still starts at its first segment's start speed and ends at most at its last segment's end speed.
   */
  gripOnly?: { topSpeed: number };
}
export const SHAPE_LABEL: Record<PlanShape, string> = {
  plan: 'brake before, accelerate out', brakeIn: 'brake in, accelerate out', coastIn: 'coast in, accelerate out',
  hold: 'hold the speed', accelIn: 'speed up in, slow down out',
};

/** A segment's planned speeds: v at distances s along it (m, m/s; s from 0 to its distance, piecewise constant acceleration). */
export interface SegmentPlan { s: number[]; v: number[] }

/** The most braking and driving (in g, before cornering takes its share) at a grip target. */
export function longLimits(car: PlanCar, target: number, kappa = 0): { brake: number; drive: number; lateral: number } {
  const f = car.frontShare, r = 1 - f, hL = car.cgHeight / Math.max(car.wheelbase, 1);
  const mf = target * (car.muLongFront ?? car.muFront), mr = target * (car.muLongRear ?? car.muRear);
  const top = Math.max(mf, mr);
  // Braking.
  let brake = top;
  const beta = !car.brakesRear ? 1 : !car.brakesFront ? 0 : Math.min(1, Math.max(0, car.brakeBias));
  if (!car.brakesFront && !car.brakesRear) brake = 0;
  else {
    if (beta > 0) { const den = beta - mf * hL; if (den > 1e-9) brake = Math.min(brake, (mf * f) / den); }
    if (beta < 1) brake = Math.min(brake, (mr * r) / ((1 - beta) + mr * hL));
    const W = car.mass * G;
    if (car.brakeForce) {
      if (beta > 0 && car.brakeForce.front > 0) brake = Math.min(brake, car.brakeForce.front / (beta * W));
      if (beta < 1 && car.brakeForce.rear > 0) brake = Math.min(brake, car.brakeForce.rear / ((1 - beta) * W));
    }
  }
  // Driving.
  let drive = top;
  const d = !car.drivenRear ? 1 : !car.drivenFront ? 0 : Math.min(1, Math.max(0, car.driveSplit));
  if (!car.drivenFront && !car.drivenRear) drive = 0;
  else {
    if (d > 0) drive = Math.min(drive, (mf * f) / (d + mf * hL));
    if (d < 1) { const den = (1 - d) - mr * hL; if (den > 1e-9) drive = Math.min(drive, (mr * r) / den); }
  }
  const lat = lateralMu(car, kappa);
  return { brake: Math.max(0, brake), drive: Math.max(0, drive), lateral: target * Math.min(lat.front, lat.rear) };
}

/**
 * The most braking or driving (g) while cornering at a_y (g): each axle within its grip ellipse at its load
 * after the fore-aft weight transfer, (F_x / μ_x W_axle)² + (F_y / μ_y W_axle)² ≤ t², with the cornering
 * split by the static loads (F_y = share · a_y) and the braking / driving by the bias / split; within the
 * brake system's force. Solved by bisection (the use grows with x).
 */
export function combinedLimit(car: PlanCar, target: number, ay: number, kind: 'brake' | 'drive', kappa = 0): number {
  const f = car.frontShare, r = 1 - f, hL = car.cgHeight / Math.max(car.wheelbase, 1);
  const mxF = car.muLongFront ?? car.muFront, mxR = car.muLongRear ?? car.muRear;
  const brake = kind === 'brake';
  const onF = brake ? car.brakesFront : car.drivenFront, onR = brake ? car.brakesRear : car.drivenRear;
  if (!onF && !onR) return 0;
  const share = !onR ? 1 : !onF ? 0 : Math.min(1, Math.max(0, brake ? car.brakeBias : car.driveSplit));
  const W = car.mass * G;
  // Each axle's lighter (inside) wheel: half the axle's braking / driving (shared equally between its wheels)
  // on its load after the sideways transfer (a_y · h / track, split by the axle's static share).
  const hT = car.track && car.track > 0 ? car.cgHeight / car.track : 0;
  const lat = lateralMu(car, kappa);
  const wheelUse = (fx: number, axleLoad: number, axleShare: number, mx: number, my: number) => {
    const inside = Math.max(1e-6, axleLoad / 2 - axleShare * ay * hT);
    const lat = (axleShare * ay) / (my * Math.max(axleLoad, 1e-6)); // the axle's cornering use (each wheel's force ∝ its load)
    return Math.max(Math.hypot(fx / (mx * Math.max(axleLoad, 1e-6)), lat), Math.hypot(fx / 2 / (mx * inside), lat));
  };
  const use = (x: number) => {
    const wf = Math.max(1e-6, brake ? f + x * hL : f - x * hL), wr = Math.max(1e-6, brake ? r - x * hL : r + x * hL);
    const uf = wheelUse(share * x, wf, f, mxF, lat.front);
    const ur = wheelUse((1 - share) * x, wr, r, mxR, lat.rear);
    let u = Math.max(uf, ur) / target;
    if (brake && car.brakeForce) {
      if (share > 0 && car.brakeForce.front > 0) u = Math.max(u, (share * x * W) / car.brakeForce.front);
      if (share < 1 && car.brakeForce.rear > 0) u = Math.max(u, ((1 - share) * x * W) / car.brakeForce.rear);
    }
    return u;
  };
  if (use(0) >= 1) return 0;
  let lo = 0, hi = 2.5 * Math.max(mxF, mxR);
  if (use(hi) <= 1) return hi;
  for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (use(m) <= 1) lo = m; else hi = m; }
  return lo;
}

const kappaOf = (sg: SegmentSpec) => (sg.path === 'straight' || (sg.latG !== null && sg.latG !== undefined && Number.isFinite(sg.latG)) ? 0 : (sg.path === 'left' ? 1 : -1) / Math.max(sg.radius, 0.1));

/**
 * Plan the speeds of a chain of segments. `target` and `shape` per segment (a grip target and a way of taking
 * it); the result has each segment's planned speeds and the whole test's time.
 */
export function planSpeeds(segments: SegmentSpec[], car: PlanCar, target: number[], shape: PlanShape[] = [], opts: PlanOptions = {}): { plans: SegmentPlan[]; time: number } {
  // Grip only: with a powertrain nothing caps the straights (it, the drag and the rolling resistance limit
  // them); without one, the top speed stands in for it.
  const free = opts.gripOnly ? { topSpeed: car.drive ? Infinity : opts.gripOnly.topSpeed } : undefined;
  const dragA = Math.max(0, car.dragArea ?? 0), mass = Math.max(car.mass, 1e-6);
  const last = segments.length - 1;
  // The grid: each segment from 0 to its distance in ≈ 1 m steps (shared boundary points).
  /** capT: the grip target of the segment whose limit `cap` is (at a boundary, the stricter side's). */
  type P = { seg: number; s: number; cap: number; capT: number; kappa: number; grade: number; bank: number; coast: boolean };
  const pts: P[] = [];
  const crr = car.rollingResistance ?? 0;
  segments.forEach((sg, i) => {
    const n = Math.max(2, Math.ceil(sg.distance / 1));
    const k0 = Math.abs(kappaOf(sg));
    const lim = longLimits(car, target[i] ?? 0.95, k0);
    const vLat = k0 > 1e-9 ? Math.sqrt(Math.max(0.01, (G * (lim.lateral + Math.sign(kappaOf(sg)) * Math.sin(sg.bank))) / (k0 * Math.max(Math.cos(sg.bank), 0.2)))) : Infinity;
    for (let k = 0; k <= n; k++) {
      const s = (sg.distance * k) / n;
      // Grip only: no set speeds but the top speed — and the test's end speed (e.g. a stop box) at its end.
      const vSet = free
        ? (i === last && k === n ? Math.min(free.topSpeed, sg.v1) : free.topSpeed)
        : Math.sqrt(Math.max(0, sg.v0 * sg.v0 + ((sg.v1 * sg.v1 - sg.v0 * sg.v0) * k) / n));
      const p: P = { seg: i, s, cap: Math.min(vSet, vLat), capT: target[i] ?? 0.95, kappa: kappaOf(sg), grade: sg.grade, bank: sg.bank, coast: !!sg.coast };
      if (k === 0 && pts.length) {
        // The boundary: the lower of both sides' limits.
        const prev = pts[pts.length - 1]!;
        if (p.cap < prev.cap) { prev.cap = p.cap; prev.capT = p.capT; }
        if (Math.abs(p.kappa) > Math.abs(prev.kappa)) prev.kappa = p.kappa;
        continue;
      }
      pts.push(p);
    }
  });
  const N = pts.length;
  if (!N) return { plans: segments.map(() => ({ s: [0], v: [0] })), time: 0 };
  const sAbs: number[] = [];
  { let base = 0; let last = -1; for (const p of pts) { if (p.seg !== last) { if (last >= 0) base += segments[last]!.distance; last = p.seg; } sAbs.push(base + p.s); } }
  // Per point: the most acceleration / deceleration (m/s²) at speed v, with the cornering's share of the grip.
  const firstHalf = (p: P) => p.s < segments[p.seg]!.distance / 2;
  const tOf = (p: P) => target[p.seg] ?? 0.95;
  const accel = (p: P, v: number) => {
    const sh = shape[p.seg] ?? 'plan';
    const resist = Math.sin(p.grade) + crr;
    const drag = (dragA * v * v) / mass;
    if (p.coast || ((sh === 'brakeIn' || sh === 'coastIn') && firstHalf(p))) return -G * resist - drag; // no throttle
    const ay = (v * v * Math.abs(p.kappa)) / G;
    // The tires' drive at the push, within what the powertrain gives at this speed.
    let push = G * combinedLimit(car, tOf(p), ay, 'drive', p.kappa);
    if (car.drive) push = Math.min(push, Math.max(0, car.drive(v)) / mass);
    return push - G * resist - drag;
  };
  const decel = (p: P, v: number, t = tOf(p)) => {
    const sh = shape[p.seg] ?? 'plan';
    const resist = Math.sin(p.grade) + crr;
    const drag = (dragA * v * v) / mass;
    if (p.coast || (sh === 'coastIn' && firstHalf(p))) return Math.max(0, G * resist + drag); // no brakes
    const ay = (v * v * Math.abs(p.kappa)) / G;
    return Math.max(0, G * (combinedLimit(car, t, ay, 'brake', p.kappa) + resist) + drag);
  };
  const pass = (cap: number[]) => {
    const caps0 = cap;
    const v = cap.slice();
    v[0] = Math.min(v[0]!, segments[0]!.v0);
    for (let i = 0; i + 1 < N; i++) {
      const ds = sAbs[i + 1]! - sAbs[i]!;
      v[i + 1] = Math.min(v[i + 1]!, Math.sqrt(Math.max(0, v[i]! * v[i]! + 2 * accel(pts[i]!, v[i]!) * ds)));
    }
    // Braking for what comes later is done at the grip target of the segment that needs it (`carry`: where
    // the braking began), when that is lower: a segment taken at a lowered target keeps its margin while the
    // car slows for it, so a turn before it isn't braked at the turn's own (higher) target — the car enters
    // that turn slower and does the slowing on the straight before.
    let carry = tOf(pts[N - 1]!);
    for (let i = N - 1; i > 0; i--) {
      const ds = sAbs[i]! - sAbs[i - 1]!;
      const p = pts[i - 1]!, own = tOf(p);
      const braked = Math.sqrt(v[i]! * v[i]! + 2 * decel(p, v[i]!, Math.min(own, carry)) * ds);
      if (braked < v[i - 1]!) v[i - 1] = braked; // slowing for later on: keep its target
      else carry = v[i - 1]! >= caps0[i - 1]! - 1e-9 ? Math.min(own, p.capT) : own; // held at a limit: that limit's target
    }
    return v;
  };
  let caps = pts.map((p) => p.cap);
  let v = pass(caps);
  // Shapes that set the speeds inside a segment from its lowest planned speed.
  if (shape.some((x) => x === 'hold' || x === 'accelIn')) {
    caps = caps.slice();
    segments.forEach((sg, i) => {
      const sh = shape[i];
      if (sh !== 'hold' && sh !== 'accelIn') return;
      const idx = pts.map((p, k) => (p.seg === i ? k : -1)).filter((k) => k >= 0);
      const lo = Math.min(...idx.map((k) => v[k]!));
      for (const k of idx) {
        const u = sg.distance > 0 ? pts[k]!.s / sg.distance : 0;
        caps[k] = Math.min(caps[k]!, sh === 'hold' ? lo : lo * (0.9 + 0.1 * (1 - Math.abs(2 * u - 1))));
      }
    });
    v = pass(caps);
  }
  // Back to segments (the shared boundary point is each segment's end and the next one's start).
  const plans: SegmentPlan[] = segments.map(() => ({ s: [], v: [] }));
  pts.forEach((p, k) => {
    plans[p.seg]!.s.push(p.s);
    plans[p.seg]!.v.push(v[k]!);
    const next = segments[p.seg + 1];
    if (next && Math.abs(p.s - segments[p.seg]!.distance) < 1e-9) { plans[p.seg + 1]!.s.push(0); plans[p.seg + 1]!.v.push(v[k]!); }
  });
  let time = 0;
  for (const pl of plans) time += planDuration(pl);
  return { plans, time };
}

// ---------------------------------------------------------------- reading a plan

const MIN_V = 0.3;
/** Time to cover a plan (constant acceleration between its points). */
export function planDuration(pl: SegmentPlan): number {
  let t = 0;
  for (let k = 1; k < pl.s.length; k++) t += (2 * (pl.s[k]! - pl.s[k - 1]!)) / Math.max(MIN_V, pl.v[k]! + pl.v[k - 1]!);
  return t;
}
const pieceAt = (pl: SegmentPlan, s: number) => {
  let lo = 0, hi = pl.s.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pl.s[m]! <= s) lo = m; else hi = m; }
  return lo;
};
/** Planned speed and acceleration at distance s along the segment. */
export function planAt(pl: SegmentPlan, s: number): { v: number; a: number } {
  if (pl.s.length < 2) return { v: pl.v[0] ?? 0, a: 0 };
  const k = pieceAt(pl, Math.min(Math.max(s, 0), pl.s[pl.s.length - 1]!));
  const s0 = pl.s[k]!, s1 = pl.s[k + 1]!, v0 = pl.v[k]!, v1 = pl.v[k + 1]!;
  const a = s1 > s0 ? (v1 * v1 - v0 * v0) / (2 * (s1 - s0)) : 0;
  return { v: Math.sqrt(Math.max(0, v0 * v0 + 2 * a * (Math.min(Math.max(s, s0), s1) - s0))), a };
}
/** Where the car is t seconds into the segment: distance, speed, acceleration. */
export function planAtTime(pl: SegmentPlan, t: number): { s: number; v: number; a: number } {
  let left = Math.max(0, t);
  for (let k = 1; k < pl.s.length; k++) {
    const ds = pl.s[k]! - pl.s[k - 1]!, v0 = pl.v[k - 1]!, v1 = pl.v[k]!;
    const dt = (2 * ds) / Math.max(MIN_V, v0 + v1);
    const a = ds > 0 ? (v1 * v1 - v0 * v0) / (2 * ds) : 0;
    if (left <= dt || k === pl.s.length - 1) {
      const tt = Math.min(left, dt);
      return { s: pl.s[k - 1]! + Math.min(ds, v0 * tt + 0.5 * a * tt * tt), v: Math.max(0, v0 + a * tt), a };
    }
    left -= dt;
  }
  return { s: pl.s[pl.s.length - 1] ?? 0, v: pl.v[pl.v.length - 1] ?? 0, a: 0 };
}
