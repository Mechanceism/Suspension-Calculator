/**
 * Steering: road-wheel angle, steering-axis torque, tie-rod / rack force and steering-wheel torque
 * (docs/MATH.md § Steering).
 *
 * Torque about the steering axis from a tire force F applied at point p:
 *   T = û · ((p − q) × F)          û = steering-axis unit vector (LBJ → UBJ / strut top / virtual pivot), q = its lower point
 * For an SLA with the spring on an arm, the ball-joint forces act on the axis and the tie rod is the
 * only thing that resists rotation about it, so the tie-rod force follows from the moment balance:
 *   T + f · û · ((r_TR − q) × d) = 0      d = unit vector tie-rod outer → inner, f = tension
 * The rack (pinion) force is the tie-rod force along the rack axis, and the steering-wheel torque is
 *   T_sw = F_rack · c / 2π                c = rack travel per steering-wheel revolution.
 */
import { type Vec3, vec3, add, sub, dot, cross, normalize, length, scale, Y_AXIS, addScaled } from '../math/vec3';
import { type Mat3, mulVec, fromAxisAngle, IDENTITY } from '../math/mat3';
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
  /** Steering-arm mechanism: torque the tie rod puts on the arm about its pivot axis, N·m (rackForce is then NaN). */
  armTorque?: number;
}

/** How the steering input moves the inner tie-rod joint (rack: mm along the rack; arm: degrees about a pivot axis). */
/** `rate`: how fast the inner tie-rod joint moves per radian of input (a center link), when it isn't simply turning about the pivot. */
export type SteeringMechanism = { kind: 'rack'; axis: Vec3 } | { kind: 'arm'; pivot: Vec3; axis: Vec3; rate?: Vec3 };

/** Lever of the tie rod about the steering axis: û · ((r_TR − q) × d), mm. */
export function steeringArmLever(state: CornerState): number {
  const p = state.points;
  const u = normalize(sub(p.steerUpper, p.steerLower));
  const d = normalize(sub(p.trInner, p.trOuter));
  return dot(u, cross(sub(p.trOuter, p.steerLower), d));
}

/**
 * Steering loads for tire forces applied at `contact` (patch centroid, or the rigid contact point).
 * @param rackAxis unit rack direction
 * @param cFactor  rack travel per steering-wheel revolution, mm/rev
 */
export function steeringLoads(state: CornerState, contact: Vec3, forces: TireForces, rackAxis: Vec3 | SteeringMechanism, cFactor: number): SteeringLoads {
  const mech: SteeringMechanism = 'kind' in rackAxis ? rackAxis : { kind: 'rack', axis: rackAxis };
  const p = state.points;
  const u = normalize(sub(p.steerUpper, p.steerLower));
  const heading = normalize(cross(state.spinAxis, Y_AXIS));
  const lateralPoint = addScaled(contact, heading, -forces.pneumaticTrail);
  const q = p.steerLower;
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
  if (mech.kind === 'arm') {
    // The tie rod pulls the arm's joint toward the knuckle (tension f along −d); torque about the pivot axis.
    // cFactor = arm degrees per steering-wheel turn, so T_wheel = T_arm · cFactor / 360.
    // With a center link, by virtual work: the force on the joint times the joint's motion per radian of input.
    const armTorque = (mech.rate ? dot(mech.rate, scale(d, -tieRodForce)) : dot(normalize(mech.axis), cross(sub(p.trInner, mech.pivot), scale(d, -tieRodForce)))) / 1000;
    return { axisTorque, tieRodForce, steeringArm: lever, rackForce: NaN, armTorque, steeringWheelTorque: (armTorque * cFactor) / 360 };
  }
  const rackForce = tieRodForce * dot(d, normalize(mech.axis));
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

/** Center-link steering (pitman arm, idler arm, center link): the points, design positions. */
export interface CenterLinkGeometry {
  /** Pitman arm: its pivot axis on the frame (steering box output) and its ball end on the center link. */
  pivot1: Vec3; pivot2: Vec3; pitmanEnd: Vec3;
  /** Idler arm: its pivot axis on the frame and its ball end on the center link. */
  idlerPivot1: Vec3; idlerPivot2: Vec3; idlerEnd: Vec3;
}

/**
 * The center link's pose for a pitman angle (deg): the pitman end turns about its axis; the idler end stays
 * on its circle at the link's length from it (Newton on the idler angle, from `guess`); the link moves
 * rigidly with the least rotation taking its design direction to the new one. x' = A + R (x − A0).
 */
export function centerLinkPose(c: CenterLinkGeometry, angleDeg: number, guess = 0): { R: Mat3; A: Vec3; A0: Vec3; idlerAngle: number } | null {
  const up = normalize(sub(c.pivot2, c.pivot1)), ui = normalize(sub(c.idlerPivot2, c.idlerPivot1));
  const rot = (u: Vec3, o: Vec3, a: number, x: Vec3) => add(o, mulVec(fromAxisAngle(u, a), sub(x, o)));
  const A = rot(up, c.pivot1, (angleDeg * Math.PI) / 180, c.pitmanEnd);
  const L = length(sub(c.idlerEnd, c.pitmanEnd));
  const f = (phi: number) => length(sub(rot(ui, c.idlerPivot1, phi, c.idlerEnd), A)) - L;
  let phi = guess;
  for (let i = 0; i < 30; i++) {
    const v = f(phi);
    if (Math.abs(v) < 1e-9) break;
    const d = (f(phi + 1e-6) - f(phi - 1e-6)) / 2e-6;
    if (Math.abs(d) < 1e-12) return null;
    phi -= v / d;
  }
  if (Math.abs(f(phi)) > 1e-6) return null;
  const Bn = rot(ui, c.idlerPivot1, phi, c.idlerEnd);
  const d0 = normalize(sub(c.idlerEnd, c.pitmanEnd)), d1 = normalize(sub(Bn, A));
  const axis = cross(d0, d1), s = length(axis), co = dot(d0, d1);
  const R = s < 1e-12 ? IDENTITY : fromAxisAngle(scale(axis, 1 / s), Math.atan2(s, co));
  return { R, A, A0: c.pitmanEnd, idlerAngle: phi };
}
