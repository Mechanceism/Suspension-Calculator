/**
 * Control-arm dimensions as design variables (docs/MATH.md § L2).
 *
 * An A-arm is its two inboard pivots (on the frame) and its ball joint (on the upright). Besides raw
 * coordinates it can be described by derived variables: effective length, pivot-axis inclination
 * and plan angle. Editing a derived variable moves the FRAME pivots and keeps the ball joint fixed,
 * so the upright, wheel and track width at static height don't change.
 */
import { type Vec3, sub, add, scale, dot, cross, length, normalize } from '../math/vec3';
import { closestPointOnLine, lineThrough } from '../math/geom';
import type { ArmPoints } from './doubleWishbone';
import { bisect } from '../math/quadrature';

export interface ArmMetrics {
  /** Fwd pivot → ball joint, mm. */
  frontLeg: number;
  /** Aft pivot → ball joint, mm. */
  rearLeg: number;
  /** Ball joint → pivot axis (perpendicular), mm. This is the arm's swing radius. */
  length: number;
  /** Distance between the two pivots, mm. */
  pivotSpacing: number;
  /** Side-view angle of the pivot axis (rad). + = front pivot higher (anti-dive style). */
  inclination: number;
  /** Plan-view angle of the pivot axis (rad). + = front pivot further outboard. */
  planAngle: number;
  /** Front-view angle of the arm (rad). + = ball joint higher than the pivot axis. */
  frontViewAngle: number;
  /** Foot of the ball joint on the pivot axis. */
  foot: Vec3;
}

export function armMetrics(a: ArmPoints): ArmMetrics {
  const foot = closestPointOnLine(lineThrough(a.aft, a.fwd), a.out);
  const d = sub(a.fwd, a.aft);
  const r = sub(a.out, foot);
  return {
    frontLeg: length(sub(a.out, a.fwd)),
    rearLeg: length(sub(a.out, a.aft)),
    length: length(r),
    pivotSpacing: length(d),
    inclination: Math.atan2(d.y, d.z),
    planAngle: Math.atan2(d.x, d.z),
    frontViewAngle: Math.atan2(r.y, Math.hypot(r.x, r.z) * Math.sign(r.x || 1)),
    foot,
  };
}

/** Set the effective arm length by sliding both frame pivots along the ball-joint → axis direction. */
export function setArmLength(a: ArmPoints, newLength: number): ArmPoints {
  const m = armMetrics(a);
  const u = normalize(sub(m.foot, a.out));
  const shift = scale(u, newLength - m.length);
  return { fwd: add(a.fwd, shift), aft: add(a.aft, shift), out: a.out };
}

/**
 * Re-aim the pivot axis to a new direction while keeping the ball joint, the arm length, the pivot
 * spacing and (as nearly as possible) the foot position. Only the frame pivots move.
 */
function withAxisDirection(a: ArmPoints, dir: Vec3): ArmPoints {
  const m = armMetrics(a);
  const oldDir = normalize(sub(a.fwd, a.aft));
  const d = normalize(dir);
  const sF = dot(sub(a.fwd, m.foot), oldDir);
  const sA = dot(sub(a.aft, m.foot), oldDir);
  const radial = sub(m.foot, a.out);
  const perp = sub(radial, scale(d, dot(radial, d)));
  const foot = add(a.out, scale(normalize(perp), m.length));
  return { fwd: add(foot, scale(d, sF)), aft: add(foot, scale(d, sA)), out: a.out };
}

/** Pivot-axis direction (aft → fwd) from side-view inclination and plan-view angle. */
const axisFromAngles = (inclination: number, planAngle: number): Vec3 =>
  normalize({ x: Math.tan(planAngle), y: Math.tan(inclination), z: 1 });

/** Set the pivot-axis side-view inclination (keeps plan angle, arm length and ball joint). */
export function setPivotInclination(a: ArmPoints, angle: number): ArmPoints {
  return withAxisDirection(a, axisFromAngles(angle, armMetrics(a).planAngle));
}

/** Set the pivot-axis plan-view angle (keeps inclination, arm length and ball joint). */
export function setPivotPlanAngle(a: ArmPoints, angle: number): ArmPoints {
  return withAxisDirection(a, axisFromAngles(armMetrics(a).inclination, angle));
}

/** Rotate v about the unit axis k by angle t (Rodrigues). */
function rotateAbout(v: Vec3, k: Vec3, t: number): Vec3 {
  const c = Math.cos(t), s = Math.sin(t);
  const kxv = cross(k, v);
  const kv = dot(k, v);
  return add(add(scale(v, c), scale(kxv, s)), scale(k, kv * (1 - c)));
}

/**
 * Set the arm's front-view angle at static height (+ = ball joint higher than the pivot axis).
 * The ball joint stays put; the pivot axis swings around it (keeping its direction, the arm length
 * and the pivot spacing), so the frame pivots move. Returns the arm unchanged if the angle can't be
 * reached within ±70° of swing.
 */
export function setArmFrontViewAngle(a: ArmPoints, angle: number): ArmPoints {
  const m = armMetrics(a);
  const d = normalize(sub(a.fwd, a.aft));
  const r0 = sub(a.out, m.foot); // foot → ball joint
  const sF = dot(sub(a.fwd, m.foot), d);
  const sA = dot(sub(a.aft, m.foot), d);
  const at = (phi: number): ArmPoints => {
    const foot = sub(a.out, rotateAbout(r0, d, phi));
    return { fwd: add(foot, scale(d, sF)), aft: add(foot, scale(d, sA)), out: a.out };
  };
  const f = (phi: number) => armMetrics(at(phi)).frontViewAngle - angle;
  const lim = (70 * Math.PI) / 180;
  // The swing direction that raises the angle depends on which way the axis points: search both.
  for (const [lo, hi] of [[0, lim], [-lim, 0]] as const) {
    if (f(lo) * f(hi) <= 0) return at(bisect(f, lo, hi, 1e-12));
  }
  return a;
}

/**
 * Move a point attached to one arm onto another arm at the same relative position: same fraction
 * of the way from the pivot axis to the ball joint, same offsets along/across the arm.
 */
export function transferArmPoint(p: Vec3, from: ArmPoints, to: ArmPoints): Vec3 {
  const frame = (a: ArmPoints) => {
    const m = armMetrics(a);
    const e1 = normalize(sub(a.out, m.foot));
    const e2 = normalize(sub(a.fwd, a.aft));
    const e3 = cross(e1, e2);
    return { m, e1, e2, e3 };
  };
  const f = frame(from);
  const t = frame(to);
  const r = sub(p, f.m.foot);
  const along = dot(r, f.e1) / f.m.length; // fraction toward the ball joint
  const axial = dot(r, f.e2);
  const normal = dot(r, f.e3);
  return add(add(add(t.m.foot, scale(t.e1, along * t.m.length)), scale(t.e2, axial)), scale(t.e3, normal));
}
