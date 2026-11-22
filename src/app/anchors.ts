/** Resolve hardpoints and derived points to their CURRENT (moved) positions, for picking and measuring. */
import { vec3, type Vec3 } from '../core/math/vec3';
import type { CornerPoints } from '../core/suspension/doubleWishbone';
import type { AnchorId, PointKey } from './store';
import type { Current } from './useModel';
import { POINT_LABELS } from './components';

/** Store point key → solved CornerPoints key. */
export const STATE_KEY: Record<PointKey, keyof CornerPoints> = {
  ucaFwd: 'ucaFwd', ucaAft: 'ucaAft', ucaOut: 'ucaOut',
  lcaFwd: 'lcaFwd', lcaAft: 'lcaAft', lcaOut: 'lcaOut',
  trInner: 'trInner', trOuter: 'trOuter', wheelCenter: 'wheelCenter',
  dmpChassis: 'damperChassis', dmpArm: 'damperArm',
  ucaOut2: 'ucaOut2', lcaOut2: 'lcaOut2',
  rkrPiv1: 'rockerPivot1', rkrPiv2: 'rockerPivot2', prArm: 'pushrodLower', prRkr: 'pushrodUpper',
};

export const DERIVED_LABELS: Record<Exclude<AnchorId, PointKey>, string> = {
  contact: 'Contact point (rigid)',
  patchCentroid: 'Patch centroid (loaded)',
  axisGround: 'Steering axis at ground',
  rollCenter: 'Roll center',
  frontViewIC: 'Front-view IC',
};

export const anchorLabel = (id: AnchorId): string =>
  (id in POINT_LABELS ? POINT_LABELS[id as PointKey] : DERIVED_LABELS[id as Exclude<AnchorId, PointKey>]);

export function anchorPosition(id: AnchorId, cur: Current): Vec3 | null {
  const c = cur.chars;
  const l = cur.loaded;
  switch (id) {
    case 'contact': return c.contactPoint;
    case 'patchCentroid': return l?.patch.centroid ?? null;
    case 'axisGround': return l?.steeringAxisAtGround ?? c.steeringAxisAtGround;
    case 'rollCenter': return c.rollCenterHeight === null ? null : vec3(0, (l?.groundY ?? c.groundY) + c.rollCenterHeight, c.contactPoint.z);
    case 'frontViewIC': return c.frontViewIC;
    default: return (cur.state.points[STATE_KEY[id]] as Vec3 | undefined) ?? null;
  }
}
