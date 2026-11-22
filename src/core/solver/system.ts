/**
 * Generic rigid-body constraint system (L1 foundation).
 *
 * The geometry is described as a set of relations (constraints) between points on rigid bodies.
 * There is no fixed solve order: the solver adjusts every free body's pose at once until all
 * relations hold (damped Gauss–Newton / Levenberg–Marquardt). This is the "system of relations,
 * not a chain" principle from GOALS.md. Any linkage type (double wishbone, MacPherson, user-made)
 * is built from the same pieces.
 *
 * Body poses: world = position + R · local. Each body's local coordinates are its design (world)
 * coordinates measured from the body's origin, so at the design pose position = origin and R = I.
 */
import {
  type Vec3, add, sub, dot, cross, length, normalize, perpendicular, rejectFrom, vec3,
} from '../math/vec3';
import { type Mat3, IDENTITY, mulVec, mul, fromRotationVector, orthonormalize } from '../math/mat3';
import { type Matrix, solveLinear, rank, norm } from '../math/linalg';

export interface Pose {
  readonly position: Vec3;
  readonly rotation: Mat3;
}

export interface Body {
  readonly id: string;
  /** Body origin in design coordinates (pose position at the design state). */
  readonly origin: Vec3;
  /** Fixed bodies are not moved by the solver; their pose is set by inputs (e.g. rack travel). */
  readonly fixed: boolean;
  /** Typical size (mm), used to scale rotation steps against translation steps. */
  readonly size: number;
}

export interface PointRef {
  readonly body: string;
  /** Point in body-local coordinates. */
  readonly local: Vec3;
}

export type Poses = Record<string, Pose>;

export interface Constraint {
  readonly name: string;
  /** Number of scalar equations. */
  readonly size: number;
  /** Write `size` residuals (0 when satisfied) starting at out[offset]. */
  residual(ctx: PoseContext, out: number[], offset: number): void;
}

export class PoseContext {
  constructor(public readonly poses: Poses) {}
  pose(body: string): Pose {
    const p = this.poses[body];
    if (!p) throw new Error(`Unknown body "${body}"`);
    return p;
  }
  world(ref: PointRef): Vec3 {
    const p = this.pose(ref.body);
    return add(p.position, mulVec(p.rotation, ref.local));
  }
  /** World direction of a body-local direction vector. */
  direction(body: string, localDir: Vec3): Vec3 {
    return mulVec(this.pose(body).rotation, localDir);
  }
}

export const designPose = (body: Body): Pose => ({ position: body.origin, rotation: IDENTITY });

// ---------------------------------------------------------------------------------------------
// System

/**
 * - converged:          all relations satisfied, motion fully determined
 * - under-constrained:  satisfied, but fewer relations than unknowns (needs more inputs)
 * - singular:           satisfied, but at/near a toggle or redundant-and-insufficient position
 * - not-converged:      relations could not all be satisfied (conflicting or unreachable inputs)
 */
export type SolveStatus = 'converged' | 'under-constrained' | 'singular' | 'not-converged';

export interface SolveResult {
  status: SolveStatus;
  poses: Poses;
  iterations: number;
  /** RMS residual at the end (mm for length constraints). */
  residualRms: number;
  /** Equations vs. unknowns vs. Jacobian rank at the solution. */
  equations: number;
  unknowns: number;
  rank: number;
  /** Conditioning indicator in [0, 1]. Near 0 means near a toggle / singular position. */
  conditioning: number;
}

export interface SolveOptions {
  maxIterations?: number;
  /** Converged when RMS residual is below this (mm). */
  tolerance?: number;
  /** Conditioning below this is reported as singular. */
  singularThreshold?: number;
}

export class ConstraintSystem {
  private readonly bodies = new Map<string, Body>();
  private readonly constraints: Constraint[] = [];

  addBody(id: string, origin: Vec3, opts: { fixed?: boolean; size?: number } = {}): Body {
    if (this.bodies.has(id)) throw new Error(`Duplicate body "${id}"`);
    const body: Body = { id, origin, fixed: opts.fixed ?? false, size: opts.size ?? 100 };
    this.bodies.set(id, body);
    return body;
  }

  getBody(id: string): Body {
    const b = this.bodies.get(id);
    if (!b) throw new Error(`Unknown body "${id}"`);
    return b;
  }

  /** Reference a point given in design (world) coordinates, attached to `body`. */
  attach(body: string, designPoint: Vec3): PointRef {
    return { body, local: sub(designPoint, this.getBody(body).origin) };
  }

  add(c: Constraint): void {
    this.constraints.push(c);
  }

  designPoses(): Poses {
    const poses: Poses = {};
    for (const b of this.bodies.values()) poses[b.id] = designPose(b);
    return poses;
  }

  get freeBodies(): Body[] {
    return [...this.bodies.values()].filter((b) => !b.fixed);
  }

  get equationCount(): number {
    return this.constraints.reduce((s, c) => s + c.size, 0);
  }

  residuals(poses: Poses): number[] {
    const ctx = new PoseContext(poses);
    const out = new Array<number>(this.equationCount).fill(0);
    let offset = 0;
    for (const c of this.constraints) {
      c.residual(ctx, out, offset);
      offset += c.size;
    }
    return out;
  }

  /**
   * Solve for all free body poses. `initial` supplies the starting poses (use the previous
   * solution when sweeping) and the poses of fixed bodies.
   */
  solve(initial: Poses, options: SolveOptions = {}): SolveResult {
    const maxIt = options.maxIterations ?? 100;
    const tol = options.tolerance ?? 1e-10;
    const singularThreshold = options.singularThreshold ?? 1e-7;
    const free = this.freeBodies;
    const n = free.length * 6;
    const m = this.equationCount;

    let poses: Poses = { ...initial };
    for (const b of this.bodies.values()) if (!poses[b.id]) poses[b.id] = designPose(b);

    let r = this.residuals(poses);
    let cost = norm(r);
    let lambda = 1e-3;
    let it = 0;

    for (; it < maxIt && cost / Math.sqrt(Math.max(m, 1)) > tol; it++) {
      const J = this.jacobian(poses, free, r);
      // Normal equations with Marquardt scaling: (JᵀJ + λ·diag(JᵀJ)) δ = −Jᵀ r
      const JtJ: Matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0));
      const Jtr = new Array<number>(n).fill(0);
      for (let i = 0; i < m; i++) {
        const row = J[i]!;
        for (let a = 0; a < n; a++) {
          const ja = row[a]!;
          if (ja === 0) continue;
          Jtr[a]! += ja * r[i]!;
          for (let b = a; b < n; b++) JtJ[a]![b]! += ja * row[b]!;
        }
      }
      for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) JtJ[a]![b] = JtJ[b]![a]!;

      let improved = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        const A = JtJ.map((row, a) => row.map((v, b) => (a === b ? v + lambda * Math.max(v, 1e-12) : v)));
        const delta = solveLinear(A, Jtr.map((v) => -v));
        if (!delta) { lambda *= 10; continue; }
        const trial = this.applyStep(poses, free, delta);
        const rTrial = this.residuals(trial);
        const costTrial = norm(rTrial);
        if (costTrial < cost) {
          poses = trial; r = rTrial; cost = costTrial;
          lambda = Math.max(lambda / 3, 1e-12);
          improved = true;
          break;
        }
        lambda *= 4;
      }
      if (!improved) break;
    }

    const residualRms = cost / Math.sqrt(Math.max(m, 1));
    const Jfinal = this.jacobian(poses, free, r);
    const info = rank(Jfinal);
    const converged = residualRms <= Math.max(tol * 10, 1e-9);
    let status: SolveStatus = 'converged';
    if (!converged) status = 'not-converged';
    else if (info.rank < n) status = m < n ? 'under-constrained' : 'singular';
    else if (info.pivotRatio < singularThreshold) status = 'singular';
    return {
      status, poses, iterations: it, residualRms,
      equations: m, unknowns: n, rank: info.rank, conditioning: info.pivotRatio,
    };
  }

  /** Central-difference Jacobian. Rotation columns are scaled by body size so columns are comparable. */
  private jacobian(poses: Poses, free: Body[], _r0: number[]): Matrix {
    const m = this.equationCount;
    const n = free.length * 6;
    const J: Matrix = Array.from({ length: m }, () => new Array<number>(n).fill(0));
    const h = 1e-6;
    free.forEach((body, bi) => {
      for (let k = 0; k < 6; k++) {
        const delta = new Array<number>(n).fill(0);
        delta[bi * 6 + k] = h;
        const plus = this.residuals(this.applyStep(poses, free, delta));
        delta[bi * 6 + k] = -h;
        const minus = this.residuals(this.applyStep(poses, free, delta));
        for (let i = 0; i < m; i++) J[i]![bi * 6 + k] = (plus[i]! - minus[i]!) / (2 * h);
      }
    });
    return J;
  }

  /**
   * Apply a parameter step. Per body: [dx, dy, dz] in mm, then [wx, wy, wz] as a rotation of
   * (w · body.size) mm at the body's size radius, i.e. rotation vector = w (radians-per-mm-scaled).
   */
  private applyStep(poses: Poses, free: Body[], delta: number[]): Poses {
    const out: Poses = { ...poses };
    free.forEach((body, bi) => {
      const p = poses[body.id]!;
      const o = bi * 6;
      const dp = vec3(delta[o]!, delta[o + 1]!, delta[o + 2]!);
      const s = 1 / body.size;
      const w = vec3(delta[o + 3]! * s, delta[o + 4]! * s, delta[o + 5]! * s);
      // Rotate about the body's current origin.
      out[body.id] = {
        position: add(p.position, dp),
        rotation: orthonormalize(mul(fromRotationVector(w), p.rotation)),
      };
    });
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// Constraint factories

/** Two points coincide (spherical / ball joint). 3 equations. */
export function coincident(name: string, a: PointRef, b: PointRef): Constraint {
  return {
    name, size: 3,
    residual(ctx, out, o) {
      const d = sub(ctx.world(a), ctx.world(b));
      out[o] = d.x; out[o + 1] = d.y; out[o + 2] = d.z;
    },
  };
}

/** Fixed distance between two points (a link with ball ends, e.g. tie rod). 1 equation. */
export function fixedDistance(name: string, a: PointRef, b: PointRef, len: number): Constraint {
  return {
    name, size: 1,
    residual(ctx, out, o) {
      out[o] = length(sub(ctx.world(a), ctx.world(b))) - len;
    },
  };
}

/**
 * Revolute (hinge) joint between body `a` and body `b` about the axis through design points
 * p1 → p2. Both bodies share the axis. 5 equations.
 */
export function revolute(
  sys: ConstraintSystem, name: string, a: string, b: string, p1: Vec3, p2: Vec3,
): Constraint {
  const a1 = sys.attach(a, p1);
  const a2 = sys.attach(a, p2);
  const b1 = sys.attach(b, p1);
  const b2 = sys.attach(b, p2);
  return {
    name, size: 5,
    residual(ctx, out, o) {
      const wa1 = ctx.world(a1);
      const wa2 = ctx.world(a2);
      const d1 = sub(ctx.world(b1), wa1);
      out[o] = d1.x; out[o + 1] = d1.y; out[o + 2] = d1.z;
      const u = normalize(sub(wa2, wa1));
      const e1 = perpendicular(u);
      const e2 = cross(u, e1);
      const d2 = sub(ctx.world(b2), wa2);
      out[o + 3] = dot(d2, e1);
      out[o + 4] = dot(d2, e2);
    },
  };
}

/** A point's coordinate along a world unit axis equals `value` (input driver). 1 equation. */
export function coordinate(name: string, p: PointRef | ((ctx: PoseContext) => Vec3), axis: Vec3, value: number): Constraint {
  const get = typeof p === 'function' ? p : (ctx: PoseContext) => ctx.world(p);
  return {
    name, size: 1,
    residual(ctx, out, o) {
      out[o] = dot(get(ctx), axis) - value;
    },
  };
}

/**
 * Signed rotation angle (radians) of body `b` relative to its design orientation, measured about
 * the fixed axis p1 → p2 using design point `ref`. Used to drive travel by arm angle. 1 equation.
 */
export function hingeAngle(
  sys: ConstraintSystem, name: string, b: string, p1: Vec3, p2: Vec3, ref: Vec3, angle: number,
): Constraint {
  const u = normalize(sub(p2, p1));
  const r0 = rejectFrom(sub(ref, p1), u);
  const refB = sys.attach(b, ref);
  return {
    name, size: 1,
    residual(ctx, out, o) {
      const r = rejectFrom(sub(ctx.world(refB), p1), u);
      out[o] = Math.atan2(dot(u, cross(r0, r)), dot(r0, r)) - angle;
    },
  };
}

/**
 * A fixed point lies on a line fixed to body `b` (through design points l1 → l2): e.g. a MacPherson strut
 * (the strut axis on the upright always passes through the top mount on the chassis; the strut slides
 * and turns on it). 2 equations.
 */
export function pointOnLine(sys: ConstraintSystem, name: string, b: string, l1: Vec3, l2: Vec3, fixedPoint: Vec3): Constraint {
  const r1 = sys.attach(b, l1);
  const r2 = sys.attach(b, l2);
  return {
    name, size: 2,
    residual(ctx, out, o) {
      const w1 = ctx.world(r1);
      const u = normalize(sub(ctx.world(r2), w1));
      const e1 = perpendicular(u);
      const e2 = cross(u, e1);
      const d = sub(fixedPoint, w1);
      out[o] = dot(d, e1);
      out[o + 1] = dot(d, e2);
    },
  };
}
