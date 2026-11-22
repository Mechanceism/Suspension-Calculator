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

/**
 * Sample MacPherson strut (front-left): L-shaped lower arm, strut from the upright up to a top mount
 * inboard and slightly rearward (KPI ≈ 13.6°, a little caster). The hub sits further outboard than on the
 * double wishbone samples so the strut clears the tire. The damper / spring is the strut.
 */
export const SAMPLE_MACPHERSON: DoubleWishboneGeometry = {
  kind: 'macpherson',
  uca: { fwd: vec3(330, 330, 150), aft: vec3(330, 330, -150), out: vec3(470, 650, -20) }, // unused (no upper arm)
  lca: { fwd: vec3(300, 20, 120), aft: vec3(330, 25, -220), out: vec3(620, 30, 5) },
  tieRod: { inner: vec3(220, 160, -130), outer: vec3(580, 160, -140) },
  wheel: { center: vec3(650, 160, 0), spinAxis: vec3(1, 0, 0), radius: WHEEL_RADIUS, width: 205 },
  damper: { chassis: vec3(470, 650, -20), arm: 'upright', armPoint: vec3(520, 300, 0) },
};

/**
 * Sample five-link multilink (left side): upper front / rear and lower front / rear links ending at
 * separate points on the upright, plus a toe link (the "tie rod"; held when the corner isn't steered).
 */
export const SAMPLE_MULTILINK: DoubleWishboneGeometry = {
  kind: 'multilink',
  uca: { fwd: vec3(280, 330, 120), aft: vec3(280, 320, -140), out: vec3(540, 320, 40), out2: vec3(530, 315, -50) },
  lca: { fwd: vec3(230, 50, 200), aft: vec3(240, 40, -150), out: vec3(565, 45, 50), out2: vec3(560, 35, -60) },
  tieRod: { inner: vec3(220, 110, -160), outer: vec3(545, 105, -150) },
  wheel: { center: WHEEL_CENTER, spinAxis: vec3(1, 0, 0), radius: WHEEL_RADIUS, width: 205 },
  damper: { chassis: vec3(300, 380, 30), arm: 'upright', armPoint: vec3(500, 60, 0) },
};

/**
 * Sample single arm, swing-arm layout (long-travel, trophy-truck style): one long lower arm pivoting on the
 * frame near the centerline (pivot line along the car), the knuckle turning on a kingpin carried by the arm.
 * The inner tie-rod joint sits near the arm's pivot line (little bump steer).
 */
export const SAMPLE_SWING_ARM: DoubleWishboneGeometry = {
  kind: 'singleArm',
  uca: { fwd: vec3(250, 330, 150), aft: vec3(250, 330, -150), out: vec3(565, 330, -10) }, // out = kingpin top (on the arm)
  lca: { fwd: vec3(80, 60, 220), aft: vec3(80, 60, -220), out: vec3(590, 30, 0) },       // pivots on the frame, out = kingpin bottom
  tieRod: { inner: vec3(90, 70, -130), outer: vec3(560, 90, -130) },
  wheel: { center: WHEEL_CENTER, spinAxis: vec3(1, 0, 0), radius: WHEEL_RADIUS, width: 205 },
  damper: { chassis: vec3(300, 450, 30), arm: 'lca', armPoint: vec3(430, 50, 30) },
};

/**
 * Sample single arm, trailing-arm layout (rear): the arm pivots ahead of the wheel on a line across the car,
 * so the wheel moves in an arc in side view with no camber change; the toe link holds the knuckle.
 */
export const SAMPLE_TRAILING_ARM: DoubleWishboneGeometry = {
  kind: 'singleArm',
  uca: { fwd: vec3(250, 330, 150), aft: vec3(250, 330, -150), out: vec3(560, 300, -10) },
  lca: { fwd: vec3(300, 80, 420), aft: vec3(520, 80, 420), out: vec3(560, 40, 0) },
  tieRod: { inner: vec3(300, 100, 380), outer: vec3(500, 100, -90) },
  wheel: { center: WHEEL_CENTER, spinAxis: vec3(1, 0, 0), radius: WHEEL_RADIUS, width: 205 },
  damper: { chassis: vec3(470, 450, -60), arm: 'lca', armPoint: vec3(500, 60, -40) },
};

/**
 * Sample solid rear axle, 3-link + Panhard rod: two lower trailing links, one upper link in the middle,
 * the Panhard rod across at axle height (roll center ≈ its height, 260 mm), coilovers on the axle.
 */
export const SAMPLE_BEAM3: DoubleWishboneGeometry = {
  kind: 'beam3',
  uca: { fwd: vec3(0, 110, 400), aft: vec3(0, 110, 400), out: vec3(0, 160, 0) },
  lca: { fwd: vec3(450, -40, 500), aft: vec3(450, -40, 500), out: vec3(450, -40, 0) },
  panhard: { chassis: vec3(-450, 160, -50), axle: vec3(450, 160, -50) },
  tieRod: { inner: vec3(200, 100, -120), outer: vec3(540, 100, -120) }, // unused
  wheel: { center: WHEEL_CENTER, spinAxis: vec3(1, 0, 0), radius: WHEEL_RADIUS, width: 205 },
  damper: { chassis: vec3(400, 500, -20), arm: 'upright', armPoint: vec3(400, 190, -20) },
};

/** Sample solid rear axle, 4-link: parallel lower trailing links, upper links angled in to locate it sideways. */
export const SAMPLE_BEAM4: DoubleWishboneGeometry = {
  kind: 'beam4',
  uca: { fwd: vec3(120, 310, 420), aft: vec3(120, 310, 420), out: vec3(250, 280, 20) },
  lca: { fwd: vec3(450, 60, 550), aft: vec3(450, 60, 550), out: vec3(450, 40, 0) },
  tieRod: { inner: vec3(200, 100, -120), outer: vec3(540, 100, -120) }, // unused
  wheel: { center: WHEEL_CENTER, spinAxis: vec3(1, 0, 0), radius: WHEEL_RADIUS, width: 205 },
  damper: { chassis: vec3(400, 500, -30), arm: 'upright', armPoint: vec3(400, 190, -30) },
};

/**
 * Sample twist beam (rear): trailing arms from bushings 450 mm ahead of the wheel, the beam's shear center on
 * the centerline 150 mm behind the bushings (a little roll camber and roll steer); the beam's twist acts as
 * the axle's anti-roll bar. Coilovers on the arms behind the wheel.
 */
export const SAMPLE_TWIST_BEAM: DoubleWishboneGeometry = {
  kind: 'twistBeam',
  uca: { fwd: vec3(250, 330, 150), aft: vec3(250, 330, -150), out: vec3(560, 300, -10) }, // unused
  lca: { fwd: vec3(480, 100, 450), aft: vec3(0, 100, 300), out: vec3(480, 100, 0) },
  tieRod: { inner: vec3(200, 100, -120), outer: vec3(540, 100, -120) }, // unused
  wheel: { center: WHEEL_CENTER, spinAxis: vec3(1, 0, 0), radius: WHEEL_RADIUS, width: 205 },
  damper: { chassis: vec3(430, 450, -80), arm: 'upright', armPoint: vec3(430, 100, -60) },
};

/** Sample solid rear axle on leaf springs: front eyes 650 mm ahead, shackles 650 mm behind, seats on top of the axle. */
export const SAMPLE_LEAF: DoubleWishboneGeometry = {
  kind: 'beamLeaf',
  uca: { fwd: vec3(250, 330, 150), aft: vec3(250, 330, -150), out: vec3(560, 300, -10) }, // unused
  lca: { fwd: vec3(450, 230, 650), aft: vec3(450, 260, -650), out: vec3(450, 180, 0) },
  tieRod: { inner: vec3(200, 100, -120), outer: vec3(540, 100, -120) }, // unused
  wheel: { center: WHEEL_CENTER, spinAxis: vec3(1, 0, 0), radius: WHEEL_RADIUS, width: 205 },
  damper: { chassis: vec3(400, 500, -30), arm: 'upright', armPoint: vec3(400, 190, -30) }, // the leaf is the spring: this only sets its (virtual) installed length
};

/** Every preset the app offers: the double wishbone samples, then one of each other type. */
export const PRESET_LAYOUTS: Layout[] = [
  ...SAMPLE_LAYOUTS,
  { id: 'M', label: 'MacPherson strut', geometry: SAMPLE_MACPHERSON },
  { id: 'L', label: 'Multilink (5 links)', geometry: SAMPLE_MULTILINK },
  { id: 'S', label: 'Single arm: swing arm (long travel)', geometry: SAMPLE_SWING_ARM },
  { id: 'T', label: 'Single arm: trailing arm', geometry: SAMPLE_TRAILING_ARM },
  { id: 'A4', label: 'Solid axle, 4-link', geometry: SAMPLE_BEAM4 },
  { id: 'A3', label: 'Solid axle, 3-link + Panhard rod', geometry: SAMPLE_BEAM3 },
  { id: 'TB', label: 'Twist beam', geometry: SAMPLE_TWIST_BEAM },
  { id: 'LF', label: 'Solid axle on leaf springs', geometry: SAMPLE_LEAF },
];
