/**
 * Compliance steer and camber (docs/MATH.md § Compliance): how much the knuckle turns under the tire's
 * forces when the arms' frame pivots are rubber bushings instead of perfect hinges.
 *
 * At a solved position, each frame pivot (a hinge between the frame and an arm) becomes two springs, one at
 * each of its axis points, stiff `axial` along the axis and `radial` across it; every other joint stays
 * rigid (ball joints, rods, the tie rod with the rack held, the wheel center held at its height by the
 * travel). Small motions x of the moving bodies (a translation and rotation each) then satisfy
 *
 *   [ K   Jᵀ ] [x]   [f]        K = Σ Gᵀ (k_r I + (k_a − k_r) u uᵀ) G   (bushing springs; G maps x to the point's motion)
 *   [ J   0  ] [λ] = [0]        J = the rigid joints' Jacobian; f = the tire force at the contact point
 *
 * and the knuckle's rotation gives the change in toe and camber per kN.
 */
import { type Vec3, vec3, sub, add, cross, normalize, Y_AXIS } from '../math/vec3';
import { mul, fromRotationVector } from '../math/mat3';
import { solveLinear } from '../math/linalg';
import type { ConstraintSystem, Poses } from '../solver/system';

export interface Bushing { name: string; body: string; p1: Vec3; p2: Vec3 }
export interface BushingStiffness { radial: number; axial: number }

/** Toe and camber change (deg) for a force (N) at the contact point. */
export interface ComplianceResult { toe: number; camber: number }

/** Toe (+ in) and camber (+ top outboard) of a left wheel from its outboard spin axis, rad. */
const toeOf = (a: Vec3) => { const h = normalize(cross(a, Y_AXIS)); return Math.atan2(-h.x, h.z); };
const camberOf = (a: Vec3) => Math.asin(Math.max(-1, Math.min(1, -a.y)));

/**
 * The knuckle's (body `upright`) toe and camber change under each force at `contact`, given the rigid
 * joints in `sys` (the bushing hinges left out), the bushings, and the solved poses.
 */
export function complianceOf(
  sys: ConstraintSystem, bushings: Bushing[], poses: Poses, stiff: BushingStiffness, contact: Vec3, spinAxis: Vec3, forces: Vec3[],
): ComplianceResult[] | null {
  const moving = Object.keys(poses).filter((b) => b !== 'chassis' && b !== 'rack' && b !== 'carrier' && poses[b]);
  if (!moving.includes('upright') || !bushings.length) return forces.map(() => ({ toe: 0, camber: 0 }));
  const n = 6 * moving.length;
  const idx = (b: string) => moving.indexOf(b) * 6;
  // A body twist (dv, dω) moved onto the poses.
  const perturb = (b: string, k: number, h: number): Poses => {
    const p = poses[b]!;
    const d = [0, 0, 0, 0, 0, 0]; d[k] = h;
    const R = k >= 3 ? mul(fromRotationVector(vec3(d[3]!, d[4]!, d[5]!)), p.rotation) : p.rotation;
    // Rotation about the body's own origin (its position): world = position + R·local.
    return { ...poses, [b]: { position: add(p.position, vec3(d[0]!, d[1]!, d[2]!)), rotation: R } };
  };
  const r0 = sys.residuals(poses);
  const m = r0.length;
  const J: number[][] = Array.from({ length: m }, () => new Array<number>(n).fill(0));
  for (const b of moving) for (let k = 0; k < 6; k++) {
    const h = k < 3 ? 1e-5 : 1e-7;
    const rp = sys.residuals(perturb(b, k, h)), rm = sys.residuals(perturb(b, k, -h));
    for (let i = 0; i < m; i++) J[i]![idx(b) + k] = (rp[i]! - rm[i]!) / (2 * h);
  }
  // G: a point's motion from its body's twist, dx = dv + dω × (p − o) = dv − [p − o]× dω.
  const G = (b: string, p: Vec3) => {
    const r = sub(p, poses[b]!.position);
    return [
      [1, 0, 0, 0, r.z, -r.y],
      [0, 1, 0, -r.z, 0, r.x],
      [0, 0, 1, r.y, -r.x, 0],
    ];
  };
  const K: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (const bu of bushings) {
    const u = normalize(sub(bu.p2, bu.p1));
    const S = [0, 1, 2].map((i) => [0, 1, 2].map((j) => (i === j ? stiff.radial : 0) + (stiff.axial - stiff.radial) * [u.x, u.y, u.z][i]! * [u.x, u.y, u.z][j]!));
    for (const pt of [bu.p1, bu.p2]) {
      const g = G(bu.body, pt), o = idx(bu.body);
      // Gᵀ S G into the body's 6 × 6 block.
      for (let a = 0; a < 6; a++) for (let c = 0; c < 6; c++) {
        let s = 0;
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) s += g[i]![a]! * S[i]![j]! * g[j]![c]!;
        K[o + a]![o + c]! += s;
      }
    }
  }
  const scaleK = Math.max(stiff.radial, stiff.axial, 1);
  const out: ComplianceResult[] = [];
  for (const F of forces) {
    const g = G('upright', contact), o = idx('upright');
    const f = new Array<number>(n + m).fill(0);
    for (let a = 0; a < 6; a++) f[o + a] = g[0]![a]! * F.x + g[1]![a]! * F.y + g[2]![a]! * F.z;
    // KKT, lightly regularized (redundant joints).
    const A: number[][] = Array.from({ length: n + m }, (_, i) => new Array<number>(n + m).fill(0));
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) A[i]![j] = K[i]![j]! + (i === j ? 1e-9 * scaleK : 0);
    for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) { A[n + i]![j] = J[i]![j]!; A[j]![n + i] = J[i]![j]!; }
    for (let i = 0; i < m; i++) A[n + i]![n + i] = -1e-12;
    const x = solveLinear(A, f);
    if (!x) return null;
    const w = vec3(x[o + 3]!, x[o + 4]!, x[o + 5]!);
    const a1 = normalize(add(spinAxis, cross(w, spinAxis)));
    out.push({ toe: ((toeOf(a1) - toeOf(spinAxis)) * 180) / Math.PI, camber: ((camberOf(a1) - camberOf(spinAxis)) * 180) / Math.PI });
  }
  return out;
}

/** Typical rubber arm bushings, N/mm. */
export const DEFAULT_BUSHING: BushingStiffness = { radial: 5000, axial: 1500 };
