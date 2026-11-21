/**
 * Suspension characteristics from a solved corner state (L2).
 * Definitions and sign conventions: docs/MATH.md § L2. Angles in radians, lengths in mm.
 *
 * Kinematic mode: the chassis is fixed and level, so the ground is the horizontal plane through
 * the rigid-tire contact point.
 */
import { type Vec3, vec3, sub, cross, normalize, X_AXIS, Y_AXIS, Z_AXIS } from '../math/vec3';
import {
  type Line, lineThrough, planeFromPoints, intersectPlanes, intersectLinePlane, pointOnLineAt,
} from '../math/geom';
import type { CornerState } from './doubleWishbone';

export interface Characteristics {
  /** + = top of wheel leans outboard. */
  camber: number;
  /** + = toe-in (front of wheel points inboard). */
  toe: number;
  /** + = top of steering axis leans rearward. */
  caster: number;
  /** + = top of steering axis leans inboard. */
  kpi: number;
  /** Kingpin offset at ground. + = axis meets ground inboard of the contact point. */
  scrubRadius: number;
  /** Caster trail at ground. + = axis meets ground ahead of the contact point. */
  mechanicalTrail: number;
  /** + = axis inboard of the wheel center, at wheel-center height. */
  kingpinOffsetAtWheelCenter: number;
  /** + = axis ahead of the wheel center, at wheel-center height. */
  casterOffsetAtWheelCenter: number;

  wheelCenter: Vec3;
  contactPoint: Vec3;
  groundY: number;
  /** Contact point X (half track for a symmetric pair). */
  halfTrack: number;

  steeringAxis: Line;
  steeringAxisAtGround: Vec3 | null;

  /** Intersection of the two arm planes. null = arm planes parallel (IC at infinity). */
  instantAxis: Line | null;
  /** Front-view IC (on the transverse plane through the contact point). null = at infinity. */
  frontViewIC: Vec3 | null;
  /** Front-view swing arm: contactPoint.x − IC.x. + = IC inboard. ±Infinity when parallel. */
  fvsa: number;
  /** Side-view IC (on the longitudinal plane through the wheel center). null = at infinity. */
  sideViewIC: Vec3 | null;
  /** Side-view swing arm: contactPoint.z − IC.z. + = IC behind. ±Infinity when parallel. */
  svsa: number;
  /** Roll center height above ground, assuming a mirrored opposite corner. null = undefined. */
  rollCenterHeight: number | null;
  /** Side-view angle of the contact point → SVIC line (anti-dive with outboard brakes). */
  antiAngleContact: number;
  /** Side-view angle of the wheel center → SVIC line (inboard brakes / drive). */
  antiAngleWheelCenter: number;

  damperLength?: number;
}

const transversePlaneAt = (z: number) => ({ point: vec3(0, 0, z), normal: Z_AXIS });
const longitudinalPlaneAt = (x: number) => ({ point: vec3(x, 0, 0), normal: X_AXIS });

export function characteristics(state: CornerState): Characteristics {
  const p = state.points;
  const a = state.spinAxis;
  const wc = p.wheelCenter;
  const cp = p.contact;
  const groundY = cp.y;

  const camber = Math.asin(Math.max(-1, Math.min(1, -a.y)));
  const heading = normalize(cross(a, Y_AXIS));
  const toe = Math.atan2(-heading.x, heading.z);

  const u = normalize(sub(p.ucaOut, p.lcaOut));
  const caster = Math.atan2(-u.z, u.y);
  const kpi = Math.atan2(-u.x, u.y);
  const steeringAxis = lineThrough(p.lcaOut, p.ucaOut);
  const g = pointOnLineAt(steeringAxis, Y_AXIS, groundY);
  const k = pointOnLineAt(steeringAxis, Y_AXIS, wc.y);

  // Instant axis from the two arm planes.
  const ucaPlane = planeFromPoints(p.ucaFwd, p.ucaAft, p.ucaOut);
  const lcaPlane = planeFromPoints(p.lcaFwd, p.lcaAft, p.lcaOut);
  const instantAxis = ucaPlane && lcaPlane ? intersectPlanes(ucaPlane, lcaPlane) : null;

  const frontViewIC = instantAxis ? intersectLinePlane(instantAxis, transversePlaneAt(cp.z)) : null;
  const sideViewIC = instantAxis ? intersectLinePlane(instantAxis, longitudinalPlaneAt(wc.x)) : null;

  // Roll center (mirrored opposite corner → RC lies on x = 0).
  let rollCenterHeight: number | null = null;
  let dir: { x: number; y: number } | null = null;
  if (frontViewIC) dir = { x: frontViewIC.x - cp.x, y: frontViewIC.y - cp.y };
  else if (ucaPlane && !instantAxis) {
    const t = cross(Z_AXIS, ucaPlane.normal); // front-view trace of the (parallel) arm planes
    dir = { x: t.x, y: t.y };
  }
  if (dir && Math.abs(dir.x) > 1e-9) {
    rollCenterHeight = cp.y + (dir.y / dir.x) * (0 - cp.x) - groundY;
  }

  const sideAngle = (ref: Vec3) =>
    sideViewIC ? Math.atan((sideViewIC.y - ref.y) / (ref.z - sideViewIC.z)) : 0;

  const out: Characteristics = {
    camber, toe, caster, kpi,
    scrubRadius: g ? cp.x - g.x : NaN,
    mechanicalTrail: g ? g.z - cp.z : NaN,
    kingpinOffsetAtWheelCenter: k ? wc.x - k.x : NaN,
    casterOffsetAtWheelCenter: k ? k.z - wc.z : NaN,
    wheelCenter: wc, contactPoint: cp, groundY, halfTrack: cp.x,
    steeringAxis, steeringAxisAtGround: g,
    instantAxis, frontViewIC,
    fvsa: frontViewIC ? cp.x - frontViewIC.x : Infinity,
    sideViewIC,
    svsa: sideViewIC ? cp.z - sideViewIC.z : Infinity,
    rollCenterHeight,
    antiAngleContact: sideAngle(cp),
    antiAngleWheelCenter: sideAngle(wc),
  };
  if (p.damperChassis && p.damperArm) {
    const d = sub(p.damperArm, p.damperChassis);
    out.damperLength = Math.hypot(d.x, d.y, d.z);
  }
  return out;
}

/** Anti-dive / anti-squat percentage: tan(θ) · (wheelbase / CG height) · force fraction · 100. */
export const antiPercent = (theta: number, wheelbase: number, cgHeight: number, fraction: number): number =>
  Math.tan(theta) * (wheelbase / cgHeight) * fraction * 100;

export const deg = (rad: number): number => (rad * 180) / Math.PI;
export const rad = (degrees: number): number => (degrees * Math.PI) / 180;
