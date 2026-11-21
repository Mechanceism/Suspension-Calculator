/**
 * Spring and load-driven equilibrium for a corner (L5, docs/MATH.md § L5).
 *
 * First version: a coilover between a chassis mount and a mount on one control arm (option 1).
 * The spring is described only by its two mount points, so a pushrod/rocker layout (option 2)
 * can supply the same two points from a rocker body later.
 *
 * Virtual work links the spring to the wheel. With L the spring length and y_c the contact-point
 * height (both functions of travel):
 *   motion ratio      MR = −dL / dy_c        (spring compression per mm of wheel travel)
 *   wheel force       F_w = F_spring · MR    (vertical force at the contact patch)
 *   wheel rate        k_w = dF_w / dy_c      (≈ k · MR² when MR is constant)
 * Equilibrium under a sprung corner load W_s: find the travel where F_w = W_s.
 */
import { distance } from '../math/vec3';
import { illinois } from '../math/roots';
import type { DoubleWishbone, CornerState } from './doubleWishbone';
import type { Poses } from '../solver/system';

export interface SpringSpec {
  /** N/mm */
  readonly rate: number;
  /** Unloaded length between mounts, mm. */
  readonly freeLength: number;
}

/** Compression-only spring force, N (0 when longer than free length). */
export const springForce = (spec: SpringSpec, length: number): number =>
  Math.max(0, spec.rate * (spec.freeLength - length));

export function springLength(state: CornerState): number | null {
  const p = state.points;
  return p.damperChassis && p.damperArm ? distance(p.damperChassis, p.damperArm) : null;
}

export interface WheelLoad {
  travel: number;
  state: CornerState;
  length: number;
  springForce: number;
  motionRatio: number;
  /** Vertical force the spring supports at the contact patch, N. */
  wheelForce: number;
}

/** Spring state and wheel force at a wheel-center travel (uses ±h solves for the motion ratio). */
export function wheelLoadAt(
  corner: DoubleWishbone, spec: SpringSpec, travel: number, rack = 0, warm?: Poses, h = 0.25,
): WheelLoad {
  const make = (t: number, w?: Poses) => corner.solve({ travel: t, rack, driver: 'wheelCenter' }, w);
  const s = make(travel, warm);
  const m = make(travel - h, s.poses);
  const p = make(travel + h, s.poses);
  const L = springLength(s);
  const Lm = springLength(m);
  const Lp = springLength(p);
  if (L === null || Lm === null || Lp === null) throw new Error('Corner has no spring mounts');
  const motionRatio = -(Lp - Lm) / (p.points.contact.y - m.points.contact.y);
  const force = springForce(spec, L);
  return { travel, state: s, length: L, springForce: force, motionRatio, wheelForce: force * motionRatio };
}

export type EquilibriumStatus = 'ok' | 'droop-limit' | 'bump-limit';

export interface Equilibrium {
  status: EquilibriumStatus;
  /** Equilibrium wheel-center travel (or the limit reached), mm. */
  travel: number;
  load: WheelLoad;
  /** Wheel rate at the equilibrium, N/mm. */
  wheelRate: number;
}

/**
 * Travel at which the spring carries `sprungLoad` (N) at the contact patch, searched within
 * `range` (mm of wheel-center travel). Reports a limit when the load can't be balanced in range.
 */
export function solveEquilibrium(
  corner: DoubleWishbone, spec: SpringSpec, sprungLoad: number, range: [number, number], rack = 0,
  guess?: number,
): Equilibrium {
  // With a guess (e.g. the previous equilibrium while animating), first try a narrow bracket.
  if (guess !== undefined && guess > range[0] && guess < range[1]) {
    const narrow: [number, number] = [Math.max(range[0], guess - 8), Math.min(range[1], guess + 8)];
    const r = solveEquilibrium(corner, spec, sprungLoad, narrow, rack);
    const atRealLimit = (r.status === 'droop-limit' && narrow[0] === range[0]) || (r.status === 'bump-limit' && narrow[1] === range[1]);
    if (r.status === 'ok' || atRealLimit) return r;
  }
  const [lo, hi] = range;
  let warm: Poses | undefined;
  const at = (t: number) => {
    const w = wheelLoadAt(corner, spec, t, rack, warm);
    warm = w.state.poses;
    return w;
  };
  const rateAt = (t: number) => {
    const d = 0.5;
    const a = at(t - d);
    const b = at(t + d);
    return (b.wheelForce - a.wheelForce) / (b.state.points.contact.y - a.state.points.contact.y);
  };
  const atLo = at(lo);
  if (atLo.wheelForce >= sprungLoad) return { status: 'droop-limit', travel: lo, load: atLo, wheelRate: rateAt(lo) };
  const atHi = at(hi);
  if (atHi.wheelForce < sprungLoad) return { status: 'bump-limit', travel: hi, load: atHi, wheelRate: rateAt(hi) };
  const t = illinois((x) => at(x).wheelForce - sprungLoad, lo, hi, atLo.wheelForce - sprungLoad, atHi.wheelForce - sprungLoad, 1e-4);
  const load = at(t);
  return { status: 'ok', travel: t, load, wheelRate: rateAt(t) };
}

/** Free length that puts the equilibrium exactly at `travel` (default: design position) for `sprungLoad`. */
export function fitFreeLength(
  corner: DoubleWishbone, rate: number, sprungLoad: number, travel = 0, rack = 0,
): number {
  const w = wheelLoadAt(corner, { rate, freeLength: 0 }, travel, rack);
  return w.length + sprungLoad / w.motionRatio / rate;
}

export interface RideMetrics {
  /** Wheel rate in series with the tire, N/mm. */
  rideRate: number;
  /** Sprung natural frequency, Hz. */
  frequency: number;
}

/** Ride rate and natural frequency. `tireRate` = Infinity for a rigid tire; mass in kg. */
export function rideMetrics(wheelRate: number, tireRate: number, sprungMass: number): RideMetrics {
  const rideRate = Number.isFinite(tireRate) ? 1 / (1 / wheelRate + 1 / tireRate) : wheelRate;
  const frequency = sprungMass > 0 && rideRate > 0 ? Math.sqrt((rideRate * 1000) / sprungMass) / (2 * Math.PI) : NaN;
  return { rideRate, frequency };
}
