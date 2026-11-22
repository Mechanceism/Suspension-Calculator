/**
 * Coilover / strut placement as numbers people set (docs/MATH.md § L5): installed length, front-view and
 * side-view angle from vertical, and where its lower mount sits along its arm. Each setter returns new
 * mount positions; the lower mount stays put except when moving it along the arm (then the whole coilover
 * moves with it, keeping its length and angles).
 */
import { type Vec3, vec3, add, sub, scale, dot, length, normalize } from '../math/vec3';
import { armMetrics } from './armGeometry';
import type { ArmPoints } from './doubleWishbone';

export interface CoiloverGeometry {
  /** Mount to mount, mm. */
  length: number;
  /** Front view, from vertical, rad: + = top inboard (−X). */
  frontViewAngle: number;
  /** Side view, from vertical, rad: + = top rearward (−Z). */
  sideViewAngle: number;
  /** Lower mount along its arm: 0 = on the pivot axis, 1 = at the ball joint (NaN when not on an arm). */
  alongArm: number;
}

export function coiloverGeometry(chassis: Vec3, lower: Vec3, arm?: ArmPoints): CoiloverGeometry {
  const d = sub(chassis, lower);
  let alongArm = NaN;
  if (arm) {
    const m = armMetrics(arm);
    alongArm = dot(sub(lower, m.foot), normalize(sub(arm.out, m.foot))) / m.length;
  }
  return { length: length(d), frontViewAngle: Math.atan2(-d.x, d.y), sideViewAngle: Math.atan2(-d.z, d.y), alongArm };
}

/** Top mount for a length and angles, from the lower mount. */
export function coiloverTop(lower: Vec3, len: number, frontViewAngle: number, sideViewAngle: number): Vec3 {
  const u = normalize(vec3(-Math.tan(frontViewAngle), 1, -Math.tan(sideViewAngle)));
  return add(lower, scale(u, len));
}

/** Change one of length / front-view angle / side-view angle; the lower mount stays. */
export function setCoilover(chassis: Vec3, lower: Vec3, which: 'length' | 'frontViewAngle' | 'sideViewAngle', value: number): Vec3 {
  const g = coiloverGeometry(chassis, lower);
  const next = { ...g, [which]: value };
  return coiloverTop(lower, next.length, next.frontViewAngle, next.sideViewAngle);
}

/** Move the lower mount along its arm to a fraction (0 pivot axis … 1 ball joint); the coilover moves as a unit. */
export function moveAlongArm(chassis: Vec3, lower: Vec3, arm: ArmPoints, fraction: number): { chassis: Vec3; lower: Vec3 } {
  const m = armMetrics(arm);
  const e1 = normalize(sub(arm.out, m.foot));
  const now = dot(sub(lower, m.foot), e1) / m.length;
  const shift = scale(e1, (fraction - now) * m.length);
  return { chassis: add(chassis, shift), lower: add(lower, shift) };
}
