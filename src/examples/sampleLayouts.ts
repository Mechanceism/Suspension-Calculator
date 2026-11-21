/**
 * Sample double wishbone layouts (front-left corner).
 *
 * All layouts share the same upright, wheel and tie rod; only the inboard pivots change.
 * A–C have their pivots on the SAME lines from each ball joint to one chosen front-view IC, so
 * they share an identical static IC, roll center and camber gain but differ in arm proportions.
 * D keeps C's pivot X positions with the IC moved closer (shorter FVSA).
 *
 * Coordinates: X outboard, Y up (Y = 0 at frame bottom), Z forward. mm.
 */
import { type Vec3, vec3 } from '../core/math/vec3';
import type { DoubleWishboneGeometry } from '../core/suspension/doubleWishbone';

const UBJ = vec3(530, 320, 0);
const LBJ = vec3(560, 40, 0);
const WHEEL_CENTER = vec3(600, 160, 0);
const WHEEL_RADIUS = 260; // ground at Y = −100 (100 mm frame ride height)
const PIVOT_HALF_SPACING = 150; // fwd/aft pivots at Z = ±150, axes parallel to Z

/** Front-view IC on the line from the contact point (600, −100) through a 50 mm-high roll center. */
export function icForFvsa(fvsa: number): Vec3 {
  const contact = vec3(600, -100, 0);
  const rcY = -50; // 50 mm above ground
  const slope = (rcY - contact.y) / (0 - contact.x);
  const x = contact.x - fvsa;
  return vec3(x, contact.y + slope * (x - contact.x), 0);
}

function pivotOnIcLine(bj: Vec3, ic: Vec3, x: number): { fwd: Vec3; aft: Vec3 } {
  const t = (x - bj.x) / (ic.x - bj.x);
  const y = bj.y + t * (ic.y - bj.y);
  return { fwd: vec3(x, y, PIVOT_HALF_SPACING), aft: vec3(x, y, -PIVOT_HALF_SPACING) };
}

export interface Layout {
  id: string;
  label: string;
  geometry: DoubleWishboneGeometry;
}

function layout(id: string, label: string, fvsa: number, ucaPivotX: number, lcaPivotX: number): Layout {
  const ic = icForFvsa(fvsa);
  // Coilover (option 1): LCA mount in the arm plane near the ball joint, chassis mount above/inboard.
  const lcaMountX = 488;
  const lcaMountY = LBJ.y + ((lcaMountX - LBJ.x) / (ic.x - LBJ.x)) * (ic.y - LBJ.y);
  return {
    id, label,
    geometry: {
      uca: { ...pivotOnIcLine(UBJ, ic, ucaPivotX), out: UBJ },
      lca: { ...pivotOnIcLine(LBJ, ic, lcaPivotX), out: LBJ },
      tieRod: { inner: vec3(200, 100, -120), outer: vec3(540, 100, -120) },
      wheel: { center: WHEEL_CENTER, spinAxis: vec3(1, 0, 0), radius: WHEEL_RADIUS, width: 205 },
      damper: { chassis: vec3(300, 380, 30), arm: 'lca', armPoint: vec3(lcaMountX, lcaMountY, 30) },
    },
  };
}

/** Default spring for the sample layouts (N/mm, mm). Free length is fitted per layout in the UI. */
export const SAMPLE_SPRING = { rate: 60, freeLength: 406 };

export const SAMPLE_LAYOUTS: Layout[] = [
  layout('A', 'Near-equal arms, FVSA 2000', 2000, 200, 220),
  layout('B', 'Short upper arm, FVSA 2000', 2000, 350, 200),
  layout('C', 'Unequal arms, FVSA 2000', 2000, 250, 200),
  layout('D', 'Unequal arms, FVSA 1000', 1000, 250, 200),
];
