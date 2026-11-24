/**
 * The shimmy model's parameters from a design (round 3, R8; docs/MATH.md § Shimmy): the steered front
 * design at ride height gives the trail, the kingpin offset at the wheel center, the steering ratio and
 * (a solid axle) the tramp; the front tires their cornering stiffness at the static load, their radius,
 * vertical rate and an estimated pneumatic trail / relaxation length when those inputs are 0; the user's
 * steering inputs the stiffness, damper, steering-wheel inertia, hands and wear.
 */
import type { VehicleProblem } from './vehicle';
import { DoubleWishbone, isBeam, type DoubleWishboneGeometry } from '../suspension/doubleWishbone';
import { characteristics } from '../suspension/characteristics';
import { steeringEffort } from '../suspension/steeringEffort';
import { inputPerRev } from '../tests/steer';
import { mfLateral, DEFAULT_MF } from '../tire/magicFormula';
import { tireRate } from '../tire/model';
import {
  shimmyScan, shimmyKick, wornParams, type ShimmyParams, type ShimmyScan, type ShimmyKick, type Wear,
} from '../vehicle/shimmy';
import type { CornerId } from '../vehicle/vehicle';

const G = 9.80665;

/** The user's shimmy inputs (all at the knuckles unless said). */
export interface ShimmySpec {
  /** Steering-system stiffness between the front wheels and the steering wheel, N·m/rad. */
  stiffness: number;
  /** Steering damper (plus the system's own friction), N·m·s/rad. */
  damper: number;
  /** Steering-wheel inertia, kg·m² (at the steering wheel). */
  steeringWheelInertia: number;
  /** The driver's hands lightly on the wheel (else hands off: the worst case). */
  handsOn: boolean;
  /** Worn: free play (rad, at the knuckles) and the stiffness / damping left (shares). */
  wear: Wear;
  /** Fastest speed to check, m/s. */
  maxSpeed: number;
  /** Wheel imbalance, kg·m (mass × radius), shaking the wheels in the kick test. */
  imbalance: number;
  /** Check shimmy in the tests (kick test, worn parts). */
  check: boolean;
}

/** Hands lightly on the steering wheel: stiffness and damping there, N·m/rad and N·m·s/rad. */
const HANDS = { stiffness: 20, damping: 2 };

export function shimmyParams(p: VehicleProblem, geometries?: Partial<Record<CornerId, DoubleWishboneGeometry>>): ShimmyParams | null {
  const sp = p.shimmy;
  if (!sp || !p.steering?.steered.FL) return null;
  const root = p.roots.FL;
  const d = p.designs[root];
  if (!d) return null;
  const g = geometries?.[root] ?? d.geometry;
  let corner: DoubleWishbone;
  try { corner = new DoubleWishbone(g); } catch { return null; }
  const st = corner.solve({ travel: 0 });
  if (st.solve.status !== 'converged') return null;
  const ch = characteristics(st);
  const eff = steeringEffort(corner, st, { cFactor: inputPerRev(0, p.steering), mu: 1, load: 1, lateralG: 0, pneumaticTrail: 0 });
  const ratio = eff?.ratio && eff.ratio > 0 ? eff.ratio : 1 / 15;
  const R = d.profile.radius / 1000, w = d.profile.width / 1000;
  // Static load on each front tire.
  const frontShare = Math.min(1, Math.max(0, 1 + p.cg.z / Math.max(p.wheelbase, 1)));
  const fz = (p.mass * G * frontShare) / 2;
  const mf = p.tireGrip ?? DEFAULT_MF;
  const Ca = Math.abs(mfLateral(mf, 0.005, { fz })) / 0.005;
  const kt = tireRate(d.model, d.profile, st.spinAxis.y, fz) * 1000; // N/m
  // Pneumatic trail and relaxation length: the inputs, or estimates from the patch (brush model: t ≈ a / 3,
  // σ ≈ 1.3 R for road tires).
  const a = Math.sqrt(Math.max(0, 2 * R * (fz / Math.max(kt, 1))));
  const tp = (p.pneumaticTrail ?? 0) > 0 ? p.pneumaticTrail! / 1000 : a / 3;
  const relax = p.ride?.relaxation ?? 0;
  const sigma = relax > 0 ? relax / 1000 : 1.3 * R;
  const mu = Math.max(1, d.unsprungMass), mwt = 0.6 * mu;
  const dOff = Number.isFinite(ch.kingpinOffsetAtWheelCenter) ? ch.kingpinOffsetAtWheelCenter / 1000 : 0;
  const knuckle = 2 * (mwt * (R * R / 4 + w * w / 12) + 0.8 * mu * dOff * dOff);
  const r2 = 1 / (ratio * ratio);
  const out: ShimmyParams = {
    trail: Number.isFinite(ch.mechanicalTrail) ? ch.mechanicalTrail / 1000 : 0,
    pneumaticTrail: tp, relaxation: sigma, cornering: 2 * Ca,
    knuckleInertia: knuckle, wheelInertia: Math.max(1e-4, sp.steeringWheelInertia) * r2,
    stiffness: sp.stiffness, freePlay: 0, damper: sp.damper,
    ...(sp.handsOn ? { hands: { stiffness: HANDS.stiffness * r2, damping: HANDS.damping * r2 } } : {}),
    spinInertia: 0.6 * mwt * R * R, radius: R, kingpinOffset: Math.abs(dOff),
  };
  if (isBeam(g.kind) && g.steeredAxle) {
    const half = Math.abs(ch.contactPoint.x) / 1000;
    const cd = d.damping ? (d.damping.bump + d.damping.rebound) / 2 : 0;
    out.axle = {
      inertia: 2 * mu * half * half,
      stiffness: 2 * (kt + d.springRate * 1000) * half * half,
      damping: 2 * cd * half * half,
      height: ch.rollCenterHeight !== null && Number.isFinite(ch.rollCenterHeight) && ch.rollCenterHeight > 0 ? ch.rollCenterHeight / 1000 : R,
    };
  }
  return out;
}

export interface ShimmyReport {
  params: ShimmyParams;
  /** Small-motion scan to the fastest speed: new parts and worn ones. */
  fresh: ShimmyScan;
  worn: ShimmyScan;
}

/** The scan for a design (new and worn); `steps` speeds from 3 m/s to the fastest. */
export function shimmyReport(p: VehicleProblem, geometries?: Partial<Record<CornerId, DoubleWishboneGeometry>>, steps = 30): ShimmyReport | null {
  const sp = p.shimmy;
  const params = shimmyParams(p, geometries);
  if (!sp || !params) return null;
  const top = Math.max(5, sp.maxSpeed);
  return { params, fresh: shimmyScan(params, top, 3, steps), worn: shimmyScan(wornParams(params, sp.wear), top, 3, steps) };
}

/** Kick test with worn parts (real free play, imbalance) and with new parts at a speed. */
export function shimmyKicks(p: VehicleProblem, u: number, geometries?: Partial<Record<CornerId, DoubleWishboneGeometry>>): { fresh: ShimmyKick; worn: ShimmyKick } | null {
  const sp = p.shimmy;
  const params = shimmyParams(p, geometries);
  if (!sp || !params) return null;
  const omega = u / Math.max(params.radius, 1e-3);
  // The imbalance's force at the wheel center (m·r·ω²) about the steering axis: the kingpin offset there is its lever.
  const imbalanceTorque = sp.imbalance * omega * omega * Math.max(params.kingpinOffset ?? 0, 0.01);
  const worn = { ...params, stiffness: params.stiffness * sp.wear.stiffness, damper: params.damper * sp.wear.damper, freePlay: sp.wear.freePlay };
  return { fresh: shimmyKick(params, u), worn: shimmyKick(worn, u, { imbalance: imbalanceTorque }) };
}
