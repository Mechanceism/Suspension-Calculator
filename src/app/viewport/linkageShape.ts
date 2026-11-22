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
