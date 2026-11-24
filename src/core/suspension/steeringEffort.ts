/**
 * Steering effort at the steering wheel (docs/MATH.md § Steering effort), for the optimizers' goals.
 *
 * By virtual work through the corner's own steering kinematics, a torque T about the steering axis needs
 *   T_sw = T · dθ/dθ_sw        dθ = the knuckle's rotation about the steering axis, dθ_sw = steering-wheel angle
 * with dθ/dθ_sw = (dθ / d input) · c / 2π (c = steering input per steering-wheel turn: rack mm or arm deg),
 * so racks, steering arms and center links are treated alike. Both front wheels count (× 2):
 * - **Parking:** the patch twisted about the steering axis's ground point against friction μ
 *   (`parkingTorque`). Grows with the scrub radius: a large one drags the patch round a circle.
 * - **At speed:** the side force at a lateral acceleration a, F = a · F_z per wheel (the inside wheel's lower
 *   load and the outside wheel's higher one add up to 2 × static), acting the pneumatic trail behind the
 *   patch, about the axis: mechanical + pneumatic trail (and the axis's tilt). Measured straight ahead at
 *   ride height, where the vertical-load (jacking) torques of the two sides cancel.
 */
import { type Vec3, vec3, sub, dot, cross, length, normalize, Y_AXIS, addScaled } from '../math/vec3';
import type { CornerInputs, CornerState, DoubleWishboneGeometry } from './doubleWishbone';
import type { Poses } from '../solver/system';
import { steeringLoads, parkingTorque } from './steering';
import { characteristics } from './characteristics';
import { patchSamples, type TireProfile } from '../tire/geometry';
import { solveLoadedHeight, type TireForceModel } from '../tire/model';

export interface EffortSpec {
  /** Steering input per steering-wheel revolution at center: rack mm/rev (steering arm: arm deg/rev). */
  cFactor: number;
  /** Tire friction for parking. */
  mu: number;
  /** Static tire load, N. */
  load: number;
  /** Lateral acceleration for the at-speed effort, g. */
  lateralG: number;
  /** Pneumatic trail, mm (the side force acts this far behind the patch). */
  pneumaticTrail: number;
  /** Tire: the patch for the parking torque (without one, the rigid contact point). */
  tire?: { profile: TireProfile; model: TireForceModel };
}

export interface SteeringEffort {
  /** Steering-wheel torque to turn both front wheels at standstill, N·m. */
  parking: number;
  /** Steering-wheel torque to hold both front wheels at the lateral g, N·m. */
  atSpeed: number;
  /** Knuckle rotation about the steering axis per steering-wheel rotation, at center. */
  ratio: number;
}

interface Solvable { solve(inputs: CornerInputs, initial?: Poses): CornerState; geometry: DoubleWishboneGeometry }

/** Steering effort of a corner design at `state` (ride height, straight ahead). null when it can't steer. */
export function steeringEffort(corner: Solvable, state: CornerState, s: EffortSpec): SteeringEffort | null {
  if (!(s.cFactor > 0)) return null;
  const h = 0.5;
  const r0 = state.inputs.rack ?? 0;
  const a = corner.solve({ ...state.inputs, rack: r0 + h }, state.poses);
  const b = corner.solve({ ...state.inputs, rack: r0 - h }, state.poses);
  if (a.solve.status !== 'converged' || b.solve.status !== 'converged') return null;
  const p = state.points;
  const u = normalize(sub(p.steerUpper, p.steerLower));
  // The knuckle's rotation about the steering axis (the spin axis seen along it), rad per input unit.
  const flat = (v: Vec3) => normalize(addScaled(v, u, -dot(v, u)));
  const fa = flat(a.spinAxis), fb = flat(b.spinAxis);
  const dTheta = Math.atan2(length(cross(fa, fb)), dot(fa, fb)) / (2 * h);
  const ratio = (dTheta * s.cFactor) / (2 * Math.PI);
  if (!(ratio > 0) || !Number.isFinite(ratio)) return null;
  const chars = characteristics(state);
  // The ground under the loaded tire (or the rigid contact).
  let groundY = chars.contactPoint.y;
  let samples: { points: Vec3[]; weights: number[] } = { points: [chars.contactPoint], weights: [1] };
  if (s.tire) {
    const ch = solveLoadedHeight(s.tire.model, s.tire.profile, dot(Y_AXIS, state.spinAxis), Math.max(s.load, 1)).centerHeight;
    groundY = p.wheelCenter.y - ch;
    const ps = patchSamples(p.wheelCenter, state.spinAxis, { point: vec3(0, groundY, 0), normal: Y_AXIS }, s.tire.profile, 24, 10);
    if (ps.points.length) samples = ps;
  }
  // The steering axis meets that ground here.
  if (Math.abs(u.y) < 1e-9) return null;
  const axisGround = addScaled(p.steerLower, u, (groundY - p.steerLower.y) / u.y);
  const park = parkingTorque(samples, axisGround, s.load, s.mu); // N·mm about the axis
  // Side force on the outside (loaded) wheel points inboard; only its torque about the axis.
  const contact = vec3(chars.contactPoint.x, groundY, chars.contactPoint.z);
  const lat = steeringLoads(state, contact, { vertical: 0, lateral: -s.lateralG * s.load, longitudinal: 0, pneumaticTrail: s.pneumaticTrail }, vec3(1, 0, 0), s.cFactor).axisTorque;
  return { parking: (2 * Math.abs(park) * ratio) / 1000, atSpeed: (2 * Math.abs(lat) * ratio) / 1000, ratio };
}
