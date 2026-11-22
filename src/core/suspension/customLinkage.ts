/**
 * User-defined corner linkages (docs/MATH.md § L1, custom): any set of rigid bodies joined to each other,
 * to the frame ('chassis') and to the steering ('rack') by
 *
 *   ball joint   the two bodies share a point                         3 equations
 *   hinge        they turn about a common axis (two points on it)    5 equations (a bushing or pin)
 *   rod          a fixed-length link with ball ends between them     1 equation  (no body of its own)
 *
 * The wheel is always carried by the body 'upright' (the knuckle). The corner needs exactly one free
 * motion (the travel) with the steering held: 6 · bodies − equations = 1. Its instant axis and steering
 * axis are found from the motion itself (screw axes between nearby solved poses), so any linkage gives
 * camber / toe curves, instant centers, roll center, KPI and caster like the built-in types.
 */
import { type Vec3, vec3, add, sub, scale, cross, dot, length, normalize, distance as dist } from '../math/vec3';
import { mul, mulVec, transpose } from '../math/mat3';
import { ConstraintSystem, type Pose, coincident, fixedDistance, revolute } from '../solver/system';

export type CustomJointKind = 'ball' | 'hinge' | 'rod';

export interface CustomJoint {
  id: string;
  kind: CustomJointKind;
  name: string;
  /** The two bodies it joins ('chassis', 'rack', 'upright' or a body id). Rod: `a` holds end p, `b` end q. */
  a: string;
  b: string;
  /** Ball: the joint; hinge: two points on its axis; rod: its two ends. */
  p: Vec3;
  q?: Vec3;
}

export interface CustomLinkage {
  /** Moving bodies besides the upright (knuckle), which is always there and carries the wheel. */
  bodies: { id: string; name: string }[];
  joints: CustomJoint[];
  /** The body the coilover's lower end is on (default the upright). */
  damperBody?: string;
}

export const FIXED_BODIES = ['chassis', 'rack'] as const;
export const JOINT_EQUATIONS: Record<CustomJointKind, number> = { ball: 3, hinge: 5, rod: 1 };

/** Every point a joint has. */
export const jointPoints = (j: CustomJoint): Vec3[] => (j.kind === 'ball' || !j.q ? [j.p] : [j.p, j.q]);

/** Points of a joint that sit on a body (both for ball / hinge; one end for a rod). */
export function jointPointsOn(j: CustomJoint, body: string): Vec3[] {
  if (j.kind === 'rod') return [...(j.a === body ? [j.p] : []), ...(j.b === body && j.q ? [j.q] : [])];
  return j.a === body || j.b === body ? jointPoints(j) : [];
}

export const movingBodies = (c: CustomLinkage): string[] => ['upright', ...c.bodies.map((b) => b.id).filter((id) => id !== 'upright')];

/** Free motions with the steering held: 6 · moving bodies − joint equations (1 = a working corner). */
export function customFreedom(c: CustomLinkage): number {
  return 6 * movingBodies(c).length - c.joints.reduce((a, j) => a + JOINT_EQUATIONS[j.kind], 0);
}

/** Problems that make a linkage unusable (empty = fine to solve). */
export function customProblems(c: CustomLinkage): string[] {
  const out: string[] = [];
  const known = new Set<string>([...FIXED_BODIES, ...movingBodies(c)]);
  for (const j of c.joints) {
    if (!known.has(j.a) || !known.has(j.b)) out.push(`${j.name}: joins a body that doesn't exist`);
    else if (j.a === j.b) out.push(`${j.name}: joins a body to itself`);
    if (j.kind !== 'ball' && (!j.q || dist(j.p, j.q) < 1e-6)) out.push(`${j.name}: its two points coincide`);
  }
  for (const b of movingBodies(c)) {
    if (!c.joints.some((j) => j.a === b || j.b === b)) out.push(`${b === 'upright' ? 'The knuckle' : c.bodies.find((x) => x.id === b)?.name ?? b} isn't joined to anything`);
  }
  const f = customFreedom(c);
  if (f !== 1) out.push(f > 1
    ? `The linkage has ${f} free motions with the steering held; a corner needs exactly 1 (the travel): add ${f - 1} more constraint${f - 1 > 1 ? 's' : ''} (a rod = 1, a ball joint = 3, a hinge = 5)`
    : `The linkage is over-constrained by ${1 - f} (a corner needs exactly 1 free motion): remove a rod (1), turn a hinge into a ball joint (−2), …`);
  return out;
}

/** A body's design origin: the centroid of the joint points on it (and the wheel center for the upright). */
export function customOrigin(c: CustomLinkage, body: string, wheelCenter: Vec3): Vec3 {
  const pts = c.joints.flatMap((j) => jointPointsOn(j, body));
  if (body === 'upright') pts.push(wheelCenter);
  if (!pts.length) return wheelCenter;
  return scale(pts.reduce((a, p) => add(a, p), vec3(0, 0, 0)), 1 / pts.length);
}

/** Add the linkage's bodies (except the upright, chassis and rack, already there) and joints. */
export function buildCustom(sys: ConstraintSystem, c: CustomLinkage, wheelCenter: Vec3): void {
  for (const b of c.bodies) {
    if (b.id === 'upright') continue;
    const o = customOrigin(c, b.id, wheelCenter);
    const pts = c.joints.flatMap((j) => jointPointsOn(j, b.id));
    sys.addBody(b.id, o, { size: Math.max(1, ...pts.map((p) => dist(p, o))) });
  }
  for (const j of c.joints) {
    if (j.kind === 'ball') sys.add(coincident(j.name, sys.attach(j.a, j.p), sys.attach(j.b, j.p)));
    else if (j.kind === 'hinge') sys.add(revolute(sys, j.name, j.a, j.b, j.p, j.q!));
    else sys.add(fixedDistance(j.name, sys.attach(j.a, j.p), sys.attach(j.b, j.q!), dist(j.p, j.q!)));
  }
}

/**
 * The screw axis of a body's small motion between two poses (body frames as the solver keeps them): a line
 * (point nearest the origin, direction), or null when it barely turns (a pure translation).
 */
export function screwBetween(a: Pose, b: Pose): { point: Vec3; dir: Vec3; w: Vec3; v: Vec3 } | null {
  const R = mul(b.rotation, transpose(a.rotation));
  // Rotation vector of R (small angles): ω ≈ ½ (R32 − R23, R13 − R31, R21 − R12).
  const w = vec3((R[7] - R[5]) / 2, (R[2] - R[6]) / 2, (R[3] - R[1]) / 2);
  const t = sub(b.position, mulVec(R, a.position)); // where the world origin goes
  if (length(w) < 1e-12) return null;
  return { point: scale(cross(w, t), 1 / dot(w, w)), dir: normalize(w), w, v: t };
}

/**
 * A custom linkage that moves exactly like a double wishbone (the usual starting point): the arms as bodies
 * on hinges, ball joints to the knuckle, the tie rod as a rod from the rack.
 */
export function customFromWishbone(g: { uca: { fwd: Vec3; aft: Vec3; out: Vec3 }; lca: { fwd: Vec3; aft: Vec3; out: Vec3 }; tieRod: { inner: Vec3; outer: Vec3 } }): CustomLinkage {
  return {
    bodies: [{ id: 'uca', name: 'Upper arm' }, { id: 'lca', name: 'Lower arm' }],
    joints: [
      { id: 'j1', kind: 'hinge', name: 'Upper arm pivot', a: 'chassis', b: 'uca', p: g.uca.fwd, q: g.uca.aft },
      { id: 'j2', kind: 'hinge', name: 'Lower arm pivot', a: 'chassis', b: 'lca', p: g.lca.fwd, q: g.lca.aft },
      { id: 'j3', kind: 'ball', name: 'Upper ball joint', a: 'uca', b: 'upright', p: g.uca.out },
      { id: 'j4', kind: 'ball', name: 'Lower ball joint', a: 'lca', b: 'upright', p: g.lca.out },
      { id: 'j5', kind: 'rod', name: 'Tie rod', a: 'rack', b: 'upright', p: g.tieRod.inner, q: g.tieRod.outer },
    ],
    damperBody: 'lca',
  };
}
