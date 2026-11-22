/**
 * What to draw for a corner of each suspension type: the arms / links, the upright outline and the
 * steering-axis points. Shared by the corner view and the vehicle view (which maps each point first).
 */
import type { Vec3 } from '../../core/math/vec3';
import type { CornerPoints, SuspensionKind } from '../../core/suspension/doubleWishbone';

export interface LinkageShape {
  /** Arm triangles (double wishbone / MacPherson lower arm), or none for links. */
  ucaTri: [Vec3, Vec3, Vec3] | null;
  lcaTri: [Vec3, Vec3, Vec3] | null;
  /** Arm or link segments. */
  uca: [Vec3, Vec3][];
  lca: [Vec3, Vec3][];
  /** Upright outline (closed polyline). */
  upright: Vec3[];
  /** Steering axis: lower and upper point. */
  axis: [Vec3, Vec3];
}

export function linkageShape(p: CornerPoints, kind: SuspensionKind): LinkageShape {
  if (kind === 'macpherson') {
    const lower = p.strutLower ?? p.damperArm ?? p.wheelCenter;
    return {
      ucaTri: null, lcaTri: [p.lcaFwd, p.lcaAft, p.lcaOut], uca: [], lca: [[p.lcaFwd, p.lcaOut], [p.lcaAft, p.lcaOut]],
      upright: [p.lcaOut, lower, p.trOuter, p.lcaOut], axis: [p.steerLower, p.steerUpper],
    };
  }
  if (kind === 'beam4' || kind === 'beam3') {
    // The whole axle: links on both sides (the right ones mirrored), the axle tube, the Panhard rod.
    const m = (v: Vec3): Vec3 => ({ x: -v.x, y: v.y, z: v.z });
    const right = p.axleRight ?? m(p.wheelCenter);
    const lower: [Vec3, Vec3][] = [[p.lcaFwd, p.lcaOut], [m(p.lcaFwd), mirrorOnAxle(p, p.lcaOut, right)]];
    const upper: [Vec3, Vec3][] = kind === 'beam4' ? [[p.ucaFwd, p.ucaOut], [m(p.ucaFwd), mirrorOnAxle(p, p.ucaOut, right)]] : [[p.ucaFwd, p.ucaOut]];
    return {
      ucaTri: null, lcaTri: null, uca: upper, lca: [...lower, ...(p.panhardChassis && p.panhardAxle ? [[p.panhardChassis, p.panhardAxle] as [Vec3, Vec3]] : [])],
      upright: [p.wheelCenter, right], axis: [p.contact, p.steerUpper],
    };
  }
  if (kind === 'singleArm') {
    // The arm (triangle to the kingpin bottom) carries the kingpin up to its top.
    return {
      ucaTri: null, lcaTri: [p.lcaFwd, p.lcaAft, p.lcaOut], uca: [], lca: [[p.lcaFwd, p.lcaOut], [p.lcaAft, p.lcaOut], [p.lcaOut, p.ucaOut]],
      upright: [p.ucaOut, p.lcaOut, p.trOuter, p.ucaOut], axis: [p.lcaOut, p.ucaOut],
    };
  }
  if (kind === 'rigid') {
    // The kingpin is held by the frame: short brackets inboard from each end.
    const br = (q: Vec3): [Vec3, Vec3] => [{ x: q.x - 120, y: q.y, z: q.z }, q];
    return {
      ucaTri: null, lcaTri: null, uca: [br(p.ucaOut)], lca: [br(p.lcaOut)],
      upright: [p.ucaOut, p.lcaOut, p.trOuter, p.ucaOut], axis: [p.lcaOut, p.ucaOut],
    };
  }
  if (kind === 'multilink') {
    const u2 = p.ucaOut2 ?? p.ucaOut, l2 = p.lcaOut2 ?? p.lcaOut;
    return {
      ucaTri: null, lcaTri: null, uca: [[p.ucaFwd, p.ucaOut], [p.ucaAft, u2]], lca: [[p.lcaFwd, p.lcaOut], [p.lcaAft, l2]],
      upright: [p.ucaOut, u2, l2, p.lcaOut, p.trOuter, p.ucaOut], axis: [p.steerLower, p.steerUpper],
    };
  }
  return {
    ucaTri: [p.ucaFwd, p.ucaAft, p.ucaOut], lcaTri: [p.lcaFwd, p.lcaAft, p.lcaOut],
    uca: [[p.ucaFwd, p.ucaOut], [p.ucaAft, p.ucaOut]], lca: [[p.lcaFwd, p.lcaOut], [p.lcaAft, p.lcaOut]],
    upright: [p.ucaOut, p.lcaOut, p.trOuter, p.ucaOut], axis: [p.lcaOut, p.ucaOut],
  };
}

/**
 * The right side's matching axle point, from the left one: mirrored about the axle's middle (a point on the
 * rigid axle). The axle's middle is between the two wheel centers.
 */
function mirrorOnAxle(p: CornerPoints, q: Vec3, right: Vec3): Vec3 {
  const c = { x: (p.wheelCenter.x + right.x) / 2, y: (p.wheelCenter.y + right.y) / 2, z: (p.wheelCenter.z + right.z) / 2 };
  // Across the axle: reflect through the plane normal to the axle line at its middle.
  const u = { x: p.wheelCenter.x - right.x, y: p.wheelCenter.y - right.y, z: p.wheelCenter.z - right.z };
  const ul = Math.hypot(u.x, u.y, u.z) || 1;
  const n = { x: u.x / ul, y: u.y / ul, z: u.z / ul };
  const d = (q.x - c.x) * n.x + (q.y - c.y) * n.y + (q.z - c.z) * n.z;
  return { x: q.x - 2 * d * n.x, y: q.y - 2 * d * n.y, z: q.z - 2 * d * n.z };
}
