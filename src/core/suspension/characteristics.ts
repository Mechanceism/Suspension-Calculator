/**
 * Suspension characteristics from a solved corner state (L2).
 * Definitions and sign conventions: docs/MATH.md § L2. Angles in radians, lengths in mm.
 *
 * Kinematic mode: the chassis is fixed and level, so the ground is the horizontal plane through
 * the rigid-tire contact point.
 */
import { type Vec3, vec3, add, sub, cross, normalize, scale, dot, length, X_AXIS, Y_AXIS, Z_AXIS } from '../math/vec3';
import {
  type Line, type Plane, lineThrough, planeFromPoints, intersectPlanes, intersectLinePlane, pointOnLineAt,
} from '../math/geom';
import type { CornerState, CornerPoints } from './doubleWishbone';

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

  /**
   * Instant axis of the upright's motion (rack held). Double wishbone: the two arm planes' intersection;
   * MacPherson: the lower-arm plane and the plane through the strut top normal to the strut; multilink:
   * the planes through the two virtual steering pivots normal to their velocities (from the links). null = at infinity.
   */
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

  const u = normalize(sub(p.steerUpper, p.steerLower));
  const caster = Math.atan2(-u.z, u.y);
  const kpi = Math.atan2(-u.x, u.y);
  const steeringAxis = lineThrough(p.steerLower, p.steerUpper);
  const g = pointOnLineAt(steeringAxis, Y_AXIS, groundY);
  const k = pointOnLineAt(steeringAxis, Y_AXIS, wc.y);

  // Instant axis: from two planes the upright's motion is confined to, or from its five links.
  let ucaPlane: Plane | null = null;
  let instantAxis: Line | null = null;
  if (state.kind === 'multilink') {
    // Planes through the two (virtual) steering pivots, normal to their velocities: for a double
    // wishbone these are exactly the arm planes. Points on the steering axis don't move when the
    // upright turns about it, so this is the suspension's axis without the bump-steer part.
    const tw = linkTwist(p);
    const vel = (q: Vec3) => (tw ? add(tw.v, cross(tw.w, q)) : null);
    const vu = vel(p.steerUpper), vl = vel(p.steerLower);
    if (vu && vl && length(vu) > 0 && length(vl) > 0) {
      ucaPlane = { point: p.steerUpper, normal: normalize(vu) };
      instantAxis = intersectPlanes(ucaPlane, { point: p.steerLower, normal: normalize(vl) });
    }
  } else {
    const lcaPlane = planeFromPoints(p.lcaFwd, p.lcaAft, p.lcaOut);
    ucaPlane = state.kind === 'macpherson' && p.strutTop && p.strutLower
      ? { point: p.strutTop, normal: normalize(sub(p.strutTop, p.strutLower)) }
      : planeFromPoints(p.ucaFwd, p.ucaAft, p.ucaOut);
    instantAxis = ucaPlane && lcaPlane ? intersectPlanes(ucaPlane, lcaPlane) : null;
  }

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

/**
 * Instantaneous screw axis of the upright held by five links (rack fixed): its twist (ω, v) keeps every
 * link's length, d_i · (v + ω × q_i) = 0 with d_i = q_i − c_i, five equations in six unknowns, so the
 * twist is their null vector (cofactors). Axis through ω × v / |ω|² along ω; null when the upright only
 * translates (axis at infinity).
 */
export function screwAxis(p: CornerPoints): Line | null {
  const tw = linkTwist(p);
  if (!tw) return null;
  const { w, v } = tw;
  const scaleN = Math.max(length(w), length(v) / 1000);
  if (!(scaleN > 0) || length(w) < 1e-9 * scaleN) return null;
  return { point: scale(cross(w, v), 1 / dot(w, w)), dir: normalize(w) };
}

/** The upright's twist (ω, v at the origin) allowed by its five links, up to scale; null if locked. */
export function linkTwist(p: CornerPoints): { w: Vec3; v: Vec3 } | null {
  const links: [Vec3, Vec3][] = [
    [p.ucaFwd, p.ucaOut], [p.ucaAft, p.ucaOut2 ?? p.ucaOut], [p.lcaFwd, p.lcaOut], [p.lcaAft, p.lcaOut2 ?? p.lcaOut], [p.trInner, p.trOuter],
  ];
  const rows = links.map(([c, q]) => {
    const d = normalize(sub(q, c));
    const m = cross(q, d);
    return [m.x, m.y, m.z, d.x, d.y, d.z];
  });
  const n = [0, 1, 2, 3, 4, 5].map((j) => (j % 2 ? -1 : 1) * det5(rows.map((r) => r.filter((_, k) => k !== j))));
  const w = vec3(n[0]!, n[1]!, n[2]!), v = vec3(n[3]!, n[4]!, n[5]!);
  return length(w) > 0 || length(v) > 0 ? { w, v } : null;
}

function det5(a: number[][]): number {
  const m = a.map((r) => [...r]);
  let det = 1;
  for (let c = 0; c < 5; c++) {
    let piv = c;
    for (let r = c + 1; r < 5; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[piv]![c]!)) piv = r;
    if (Math.abs(m[piv]![c]!) < 1e-300) return 0;
    if (piv !== c) { [m[piv], m[c]] = [m[c]!, m[piv]!]; det = -det; }
    det *= m[c]![c]!;
    for (let r = c + 1; r < 5; r++) {
      const f = m[r]![c]! / m[c]![c]!;
      for (let k = c; k < 5; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  return det;
}

/** Anti-dive / anti-squat percentage: tan(θ) · (wheelbase / CG height) · force fraction · 100. */
export const antiPercent = (theta: number, wheelbase: number, cgHeight: number, fraction: number): number =>
  Math.tan(theta) * (wheelbase / cgHeight) * fraction * 100;

export const deg = (rad: number): number => (rad * 180) / Math.PI;
export const rad = (degrees: number): number => (degrees * Math.PI) / 180;
