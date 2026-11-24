/**
 * Steering for a turn (Phase A): the road-wheel angle a turn of radius R needs, and the rack travel that
 * gives it with the car's own steering kinematics.
 *
 *   ideal (low speed, Ackermann) road-wheel angle   δ = atan(wheelbase ÷ R)
 *
 * The steered axle's angle is the mean of its two wheels' heading change from straight ahead, each found
 * by solving the corner with the rack moved (the left corner's rack moves +r, the mirrored right corner's
 * −r, the same convention as the Vehicle view). The rack travel is found by a secant search on that
 * curve; a turn that needs more than the rack limit can't be driven (Steering lock check).
 * At speed the tires run at slip angles, so the steering needs the slip difference on top (bicycle model):
 *   δ = atan(wheelbase ÷ R) + (α_front − α_rear)        more front slip = understeer = more steering
 * The slip angles come from the tire grip model at the solved state (`extra`).
 */
import type { DoubleWishbone } from '../suspension/doubleWishbone';
import { headingAngle } from '../suspension/steering';
import { CORNER_IDS, isFront, isLeft, type CornerId } from '../vehicle/vehicle';
import type { PathKind } from './segments';

export interface SteeringSpec {
  /** Which corners steer. */
  steered: Partial<Record<CornerId, boolean>>;
  /** Rack travel limit, ± mm. */
  rackLimit: number;
  /** Rack travel per steering-wheel revolution, mm (steering arm: arm degrees per revolution). At center. */
  cFactor: number;
  /** Variable ratio (geared cam / variable-ratio rack): the same at full lock; omitted or ≤ 0 = constant. */
  cFactorLock?: number;
  /**
   * Measured ratio: steering-wheel angle (deg) vs input (rack mm or arm deg) from center out (mirrored for the
   * other way). When given (2+ pairs) it replaces cFactor / cFactorLock: linear between the pairs, the end
   * slopes beyond them.
   */
  curve?: { wheel: number; input: number }[];
}

type RatioSpec = Pick<SteeringSpec, 'cFactor' | 'cFactorLock' | 'rackLimit' | 'curve'>;

/** A usable curve: from center (0, 0) out, both columns increasing; null when there isn't one. */
function curveOf(s: RatioSpec): { wheel: number[]; input: number[] } | null {
  const c = s.curve;
  if (!c || c.length < 1) return null;
  const pts = [{ wheel: 0, input: 0 }, ...c.filter((p) => p.wheel > 0 && p.input > 0)].sort((a, b) => a.wheel - b.wheel);
  for (let i = 1; i < pts.length; i++) if (!(pts[i]!.input > pts[i - 1]!.input) || !(pts[i]!.wheel > pts[i - 1]!.wheel)) return null;
  return pts.length >= 2 ? { wheel: pts.map((p) => p.wheel), input: pts.map((p) => p.input) } : null;
}

/** Piecewise-linear y(x) on increasing xs, extended by the end slopes. */
function interp(xs: number[], ys: number[], x: number): number {
  const n = xs.length;
  let i = 0;
  while (i < n - 2 && x > xs[i + 1]!) i++;
  return ys[i]! + ((ys[i + 1]! - ys[i]!) * (x - xs[i]!)) / (xs[i + 1]! - xs[i]!);
}

/** Parse "wheel°, input" pairs, one per line (or ';'); returns the pairs and any lines that couldn't be read. */
export function parseSteerCurve(text: string): { curve: { wheel: number; input: number }[]; bad: string[]; ok: boolean } {
  const curve: { wheel: number; input: number }[] = [];
  const bad: string[] = [];
  for (const line of text.split(/[\n;]+/).map((l) => l.trim()).filter(Boolean)) {
    const m = /^(-?\d+(?:\.\d+)?)\s*[, \t]\s*(-?\d+(?:\.\d+)?)$/.exec(line);
    if (!m) { bad.push(line); continue; }
    curve.push({ wheel: Math.abs(Number(m[1])), input: Math.abs(Number(m[2])) });
  }
  return { curve, bad, ok: !!curveOf({ cFactor: 1, rackLimit: 1, curve }) };
}

/**
 * Steering-wheel angle (deg) for a steering input (rack mm or arm deg). The input per wheel revolution goes
 * from cFactor at center to cFactorLock at full lock, linearly with |input| / limit:
 *   c(r) = c0 + (c1 − c0)·|r|/L,   θ_sw(r) = 360 · ∫ dr / c(r) = 360 · L / (c1 − c0) · ln(c(r) / c0)
 */
export function steeringWheelAngle(input: number, s: RatioSpec): number {
  const cv = curveOf(s);
  if (cv) return Math.sign(input) * interp(cv.input, cv.wheel, Math.abs(input));
  const c0 = s.cFactor, c1 = s.cFactorLock && s.cFactorLock > 0 ? s.cFactorLock : c0, L = Math.abs(s.rackLimit) || 1;
  if (!(c0 > 0)) return NaN;
  if (Math.abs(c1 - c0) < 1e-9 * c0) return (input / c0) * 360;
  const k = (c1 - c0) / L;
  return Math.sign(input) * (360 / k) * Math.log((c0 + k * Math.abs(input)) / c0);
}

/** Inverse of steeringWheelAngle: the steering input for a steering-wheel angle (deg). */
export function inputForWheelAngle(sw: number, s: RatioSpec): number {
  const cv = curveOf(s);
  if (cv) return Math.sign(sw) * interp(cv.wheel, cv.input, Math.abs(sw));
  const c0 = s.cFactor, c1 = s.cFactorLock && s.cFactorLock > 0 ? s.cFactorLock : c0, L = Math.abs(s.rackLimit) || 1;
  if (!(c0 > 0)) return NaN;
  if (Math.abs(c1 - c0) < 1e-9 * c0) return (sw / 360) * c0;
  const k = (c1 - c0) / L;
  return Math.sign(sw) * (c0 / k) * (Math.exp((k * Math.abs(sw)) / 360) - 1);
}

/** Input per steering-wheel revolution at an input (the local ratio), rack mm/rev or arm deg/rev. */
export function inputPerRev(input: number, s: RatioSpec): number {
  const cv = curveOf(s);
  if (cv) {
    // The local slope of the curve, per revolution.
    const a = Math.abs(input), h = Math.max(1e-3, (cv.input[cv.input.length - 1]! || 1) * 1e-3);
    const w0 = interp(cv.input, cv.wheel, Math.max(0, a - h)), w1 = interp(cv.input, cv.wheel, a + h);
    return w1 > w0 ? (360 * (a + h - Math.max(0, a - h))) / (w1 - w0) : NaN;
  }
  const c0 = s.cFactor, c1 = s.cFactorLock && s.cFactorLock > 0 ? s.cFactorLock : c0, L = Math.abs(s.rackLimit) || 1;
  return c0 + (c1 - c0) * Math.min(1, Math.abs(input) / L);
}

export interface SteerNeed {
  /** Rack travel the turn needs, mm (+ = toward the left; the left corner's rack input). */
  rack: number;
  /** Rack travel used (clamped to the limit), mm. */
  rackUsed: number;
  /** Mean road-wheel angle the turn needs, deg (+ = left), slip included. */
  wheelAngle: number;
  /** Part of it from the tires' slip angles (front − rear), deg (+ = understeer). */
  slip: number;
  /** Mean road-wheel angle at full lock in the turn's direction, deg (magnitude). */
  maxAngle: number;
  /** Steering-wheel angle for the needed rack travel, deg. */
  steeringWheel: number;
  limit: number;
  /** Needs more than the rack limit (or the steering can't reach it at all). */
  over: boolean;
  /**
   * Over time: the driver is steering mostly to get back to the line (m off it, + = left), not for the turn
   * itself; `turnAngle` is what the turn alone needs at the road wheels, deg (no slip).
   */
  offLine?: number;
  turnAngle?: number;
  /** No steered wheels (or the rack doesn't turn them). */
  none: boolean;
}

const DEG = 180 / Math.PI;
const cache = new WeakMap<object, Map<string, SteerNeed | null>>();

/**
 * Rack travel for a turn. `built` holds one DoubleWishbone per design root, `roots` maps corners to roots.
 * Returns null for a straight.
 */
export function steerForTurn(
  built: Map<CornerId, DoubleWishbone>, roots: Record<CornerId, CornerId>, steering: SteeringSpec,
  wheelbase: number, path: PathKind, radius: number, extra = 0,
): SteerNeed | null {
  if (path === 'straight') return null;
  const ex = Number.isFinite(extra) ? Math.round(extra / 1e-5) * 1e-5 : 0;
  const key = `${path}|${radius}|${ex}|${wheelbase}|${steering.rackLimit}|${steering.cFactor}|${steering.cFactorLock ?? 0}|${JSON.stringify(steering.curve ?? [])}|${CORNER_IDS.map((id) => (steering.steered[id] ? 1 : 0)).join('')}`;
  let m = cache.get(built);
  if (!m) { m = new Map(); cache.set(built, m); }
  if (m.has(key)) return m.get(key)!;
  const out = compute(built, roots, steering, wheelbase, path, radius, ex);
  m.set(key, out);
  return out;
}

function compute(
  built: Map<CornerId, DoubleWishbone>, roots: Record<CornerId, CornerId>, steering: SteeringSpec,
  wheelbase: number, path: PathKind, radius: number, extra: number,
): SteerNeed {
  const limit = Math.abs(steering.rackLimit);
  const sign = path === 'left' ? 1 : -1;
  const delta = Math.max(0, Math.atan(wheelbase / 1000 / Math.max(radius, 0.01)) + extra);
  const none: SteerNeed = { rack: NaN, rackUsed: 0, wheelAngle: sign * delta * DEG, slip: extra * DEG, maxAngle: 0, steeringWheel: NaN, limit, over: true, none: true };
  const front = CORNER_IDS.filter((id) => isFront(id) && steering.steered[id]);
  const rear = CORNER_IDS.filter((id) => !isFront(id) && steering.steered[id]);
  const ids = front.length ? front : rear;
  if (!ids.length) return none;
  // Rear steer turns the car the other way for the same wheel angle.
  const target = (front.length ? 1 : -1) * sign * delta;
  const straight = new Map<CornerId, number>();
  const heading = (root: CornerId, rack: number): number => {
    const c = built.get(root);
    if (!c) return NaN;
    if (!straight.has(root)) straight.set(root, headingAngle(c.design().spinAxis));
    try {
      const st = c.solve({ travel: 0, rack });
      return st.solve.status === 'converged' ? headingAngle(st.spinAxis) - straight.get(root)! : NaN;
    } catch { return NaN; }
  };
  // Vehicle yaw of a wheel, + = front toward the left. Left corners: local +X is left; right corners are mirrored.
  const yaw = (rack: number) => ids.reduce((a, id) => a + (isLeft(id) ? heading(roots[id], rack) : -heading(roots[id], -rack)), 0) / ids.length;
  const k = (yaw(1) - yaw(-1)) / 2; // rad per mm
  if (!Number.isFinite(k) || Math.abs(k) < 1e-7) return none;
  // Secant search, kept within a generous window around the limit.
  const span = Math.max(4 * limit, 200);
  let r0 = 0, y0 = 0;
  let r1 = Math.max(-span, Math.min(span, target / k));
  let y1 = yaw(r1);
  for (let i = 0; i < 12 && Number.isFinite(y1) && Math.abs(y1 - target) > 1e-5; i++) {
    const slope = Math.abs(y1 - y0) > 1e-9 ? (y1 - y0) / (r1 - r0) : k;
    const r2 = Math.max(-span, Math.min(span, r1 + (target - y1) / slope));
    r0 = r1; y0 = y1; r1 = r2; y1 = yaw(r1);
  }
  const reached = Number.isFinite(y1) && Math.abs(y1 - target) < 1e-3;
  const rack = reached ? r1 : target / k; // linear estimate when the kinematics can't get there
  const dir = Math.sign(rack) || 1;
  const atLimit = yaw(dir * limit);
  const rackUsed = Math.max(-limit, Math.min(limit, rack));
  return {
    rack, rackUsed, wheelAngle: sign * delta * DEG, slip: extra * DEG, maxAngle: Number.isFinite(atLimit) ? Math.abs(atLimit) * DEG : 0,
    steeringWheel: steering.cFactor > 0 ? steeringWheelAngle(rack, steering) : NaN,
    limit, over: !reached || Math.abs(rack) > limit + 1e-6, none: false,
  };
}

/** Road-wheel heading change of a corner at a rack travel (ride height), rad: + = front of the wheel toward the corner's outboard side. NaN if it can't be solved. */
export function wheelSteerAngle(corner: DoubleWishbone, rack: number): number {
  try {
    const st = corner.solve({ travel: 0, rack });
    return st.solve.status === 'converged' ? headingAngle(st.spinAxis) - headingAngle(corner.design().spinAxis) : NaN;
  } catch { return NaN; }
}

export interface FullLock {
  /** Rack travel each way, mm. */
  rack: number;
  /** Road-wheel angles at full lock, rad: the wheel on the inside of the turn and on the outside. */
  inside: number;
  outside: number;
}

/**
 * Rack travel each way from a measured road-wheel angle of one front wheel:
 *   'span'   = the angle from full lock one way to full lock the other (inside + outside angle)
 *   'inside' = from straight ahead to full lock, the wheel on the inside of the turn
 * using the corner's own steering kinematics (bisection on the rack travel). null if it can't reach it.
 */
export function rackForWheelAngle(corner: DoubleWishbone, angle: number, mode: 'span' | 'inside'): FullLock | null {
  const s = Math.sign(wheelSteerAngle(corner, 1)) || 1; // rack direction that turns this wheel outboard (it is then on the inside)
  const at = (L: number) => {
    const inside = Math.abs(wheelSteerAngle(corner, s * L)), outside = Math.abs(wheelSteerAngle(corner, -s * L));
    return { inside, outside, value: mode === 'span' ? inside + outside : inside };
  };
  let hi = 5;
  while (hi < 300 && Number.isFinite(at(hi).value) && at(hi).value < angle) hi *= 1.5;
  if (!Number.isFinite(at(hi).value) || at(hi).value < angle) return null;
  let lo = 0;
  for (let k = 0; k < 50; k++) { const m = (lo + hi) / 2; const v = at(m).value; if (Number.isFinite(v) && v < angle) lo = m; else hi = m; }
  const L = (lo + hi) / 2;
  const r = at(L);
  return { rack: L, inside: r.inside, outside: r.outside };
}
