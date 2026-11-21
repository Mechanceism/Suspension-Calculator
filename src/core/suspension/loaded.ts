/**
 * Loaded tire at a solved corner position (kinematic mode with a tire load).
 *
 * The chassis and wheel position come from the kinematic solve. The tire then carries a vertical
 * load: the ground plane (level, normal +Y) rises until the tire force equals the load. Scrub
 * radius and trail are reported against the real contact-patch centroid ("effective" values,
 * docs/MATH.md § L2).
 */
import { vec3, Y_AXIS, dot, type Vec3 } from '../math/vec3';
import { pointOnLineAt } from '../math/geom';
import { contactPatch, type ContactPatch, type TireProfile } from '../tire/geometry';
import { solveLoadedHeight, tireForce, type TireForce, type TireForceModel } from '../tire/model';
import type { CornerState } from './doubleWishbone';
import type { Characteristics } from './characteristics';

export interface LoadedCorner {
  /** Ground plane height (Y) that carries the load. */
  groundY: number;
  /** Tire compression relative to the rigid-tire contact point, mm (+ = compressed). */
  deflection: number;
  patch: ContactPatch;
  force: TireForce;
  bottomedOut: boolean;
  /** Steering-axis intercept with the loaded ground plane. */
  steeringAxisAtGround: Vec3 | null;
  /** Scrub radius to the patch centroid, mm (+ = axis inboard). */
  effectiveScrubRadius: number;
  /** Mechanical trail to the patch centroid, mm (+ = axis ahead). */
  effectiveTrail: number;
}

export function loadCorner(
  state: CornerState, chars: Characteristics, profile: TireProfile, model: TireForceModel, load: number,
): LoadedCorner {
  const wc = state.points.wheelCenter;
  const tilt = dot(Y_AXIS, state.spinAxis);
  const solved = solveLoadedHeight(model, profile, tilt, load);
  const groundY = wc.y - solved.centerHeight;
  const patch = contactPatch(wc, state.spinAxis, { point: vec3(0, groundY, 0), normal: Y_AXIS }, profile);
  const g = pointOnLineAt(chars.steeringAxis, Y_AXIS, groundY);
  const c = patch.centroid;
  return {
    groundY,
    deflection: groundY - chars.contactPoint.y,
    patch,
    force: tireForce(model, profile, patch),
    bottomedOut: solved.bottomedOut,
    steeringAxisAtGround: g,
    effectiveScrubRadius: g && c ? c.x - g.x : NaN,
    effectiveTrail: g && c ? g.z - c.z : NaN,
  };
}
