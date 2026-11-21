/**
 * Steering: road-wheel angle, steering-axis torque, tie-rod / rack force and steering-wheel torque
 * (docs/MATH.md § Steering).
 *
 * Torque about the steering axis from a tire force F applied at point p:
 *   T = û · ((p − q) × F)          û = steering-axis unit vector (LBJ → UBJ), q = LBJ
 * For an SLA with the spring on an arm, the ball-joint forces act on the axis and the tie rod is the
 * only thing that resists rotation about it, so the tie-rod force follows from the moment balance:
 *   T + f · û · ((r_TR − q) × d) = 0      d = unit vector tie-rod outer → inner, f = tension
 * The rack (pinion) force is the tie-rod force along the rack axis, and the steering-wheel torque is
 *   T_sw = F_rack · c / 2π                c = rack travel per steering-wheel revolution.
 */
import { type Vec3, vec3, sub, dot, cross, normalize, length, Y_AXIS, addScaled } from '../math/vec3';
import type { CornerState, DoubleWishboneGeometry } from './doubleWishbone';

/** Wheel heading in plan view (rad): + = front of the wheel toward +X (outboard). */
export function headingAngle(spinAxis: Vec3): number {
  const f = normalize(cross(spinAxis, Y_AXIS));
  return Math.atan2(f.x, f.z);
}

/** Current LCA rotation about its pivot axis relative to design (rad, + = ball joint up). */
export function lowerArmAngle(geometry: DoubleWishboneGeometry, state: CornerState): number {
  const { aft, fwd, out } = geometry.lca;
  const u = normalize(sub(fwd, aft));
  const rej = (v: Vec3) => addScaled(v, u, -dot(v, u));
  const r0 = rej(sub(out, aft));
  const r = rej(sub(state.points.lcaOut, aft));
  return Math.atan2(dot(u, cross(r0, r)), dot(r0, r));
}

export interface TireForces {
  /** Vertical force from the ground on the tire, N (+ up). */
  vertical: number;
  /** Lateral force, N, along world X (+ outboard). */
  lateral: number;
  /** Longitudinal force, N, along world Z (+ forward = drive; braking is negative). */
  longitudinal: number;
  /** Pneumatic trail, mm: the lateral force acts this far behind the patch center. */
  pneumaticTrail: number;
}

export interface SteeringLoads {
  /** Torque about the steering axis from the tire forces, N·mm. + = turns the front of the wheel outboard. */
  axisTorque: number;
  /** Tie-rod force, N (+ = tension). */
  tieRodForce: number;
  /** Effective steering-arm lever about the axis, mm (tie-rod force → axis torque). */
  steeringArm: number;
  /** Force the rack must apply along the rack axis to hold the wheel, N. */
  rackForce: number;
  /** Steering-wheel torque for this corner, N·m. */
  steeringWheelTorque: number;
}

/** Lever of the tie rod about the steering axis: û · ((r_TR − q) × d), mm. */
export function steeringArmLever(state: CornerState): number {
  const p = state.points;
  const u = normalize(sub(p.ucaOut, p.lcaOut));
  const d = normalize(sub(p.trInner, p.trOuter));
  return dot(u, cross(sub(p.trOuter, p.lcaOut), d));
}

/**
 * Steering loads for tire forces applied at `contact` (patch centroid, or the rigid contact point).
 * @param rackAxis unit rack direction
 * @param cFactor  rack travel per steering-wheel revolution, mm/rev
 */
export function steeringLoads(state: CornerState, contact: Vec3, forces: TireForces, rackAxis: Vec3, cFactor: number): SteeringLoads {
  const p = state.points;
  const u = normalize(sub(p.ucaOut, p.lcaOut));
  const heading = normalize(cross(state.spinAxis, Y_AXIS));
  const lateralPoint = addScaled(contact, heading, -forces.pneumaticTrail);
  const q = p.lcaOut;
  const fVert = vec3(0, forces.vertical, 0);
  const fLong = vec3(0, 0, forces.longitudinal);
  const fLat = vec3(forces.lateral, 0, 0);
  const axisTorque =
    dot(u, cross(sub(contact, q), fVert)) +
    dot(u, cross(sub(contact, q), fLong)) +
    dot(u, cross(sub(lateralPoint, q), fLat));
  const lever = steeringArmLever(state);
  const d = normalize(sub(p.trInner, p.trOuter));
  const tieRodForce = Math.abs(lever) > 1e-9 ? -axisTorque / lever : NaN;
  const rackForce = tieRodForce * dot(d, normalize(rackAxis));
  return {
    axisTorque, tieRodForce, steeringArm: lever, rackForce,
    steeringWheelTorque: (rackForce * cFactor) / (2 * Math.PI) / 1000,
  };
}

/**
 * Parking (standstill) scrub torque about the steering axis, N·mm: the patch is twisted about the
 * axis's ground point against friction μ, with the vertical load spread evenly over the patch.
 *   T = μ · (F_z / A) · ∫ |r| dA      (page 1 of the hand math, generalized to any patch shape)
 */
export function parkingTorque(samples: { points: Vec3[]; weights: number[] }, axisGround: Vec3, vertical: number, mu: number): number {
  const area = samples.weights.reduce((s, w) => s + w, 0);
  if (area <= 0) return 0;
  let moment = 0;
  samples.points.forEach((pt, i) => {
    const r = sub(pt, axisGround);
    moment += samples.weights[i]! * length(vec3(r.x, 0, r.z));
  });
  return (mu * vertical * moment) / area;
}
