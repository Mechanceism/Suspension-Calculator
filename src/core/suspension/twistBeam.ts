/**
 * Twist-beam axle kinematics (docs/MATH.md § L1, twist beam): two trailing arms, each on a bushing, joined
 * by a cross beam that is stiff in bending and soft in torsion. Coordinates as for the solid axle.
 *
 * The usual kinematic model, with two parameters:
 *   heave θ: both arms swing together about the line through the two bushings (a lateral line), so the
 *            wheels move like plain trailing arms (no camber or toe change);
 *   twist ψ: each arm turns about the line from its bushing to the beam's shear center on the centerline
 *            (where that point is after the heave), the left by ψ and the right by −ψ (mirrored).
 * So in pure heave it is a trailing arm, in pure roll each wheel moves like a semi-trailing arm about
 * bushing → shear center: the roll center, roll camber and roll steer come from where the shear center is.
 * Inputs are the two wheel-center travels; θ and ψ are found from them (Newton, 2 × 2).
 */
import { type Vec3, vec3, add, sub, normalize, length, distance as dist, Y_AXIS, X_AXIS } from '../math/vec3';
import { type Mat3, mul, mulVec, fromAxisAngle, IDENTITY } from '../math/mat3';
import type { Poses } from '../solver/system';
import type { AxleState, AxleWheel } from './solidAxle';

export interface TwistBeamGeometry {
  readonly kind: 'twistBeam';
  /** The left wheel (x > 0): center, spin axis (outboard), rolling radius. */
  readonly wheel: { readonly center: Vec3; readonly spinAxis: Vec3; readonly radius: number; readonly width?: number };
  /** The left arm's bushing (frame end), mm. */
  readonly bushing: Vec3;
  /** The beam's shear center (on the centerline; its x is taken as 0), mm. */
  readonly shearCenter: Vec3;
  /** Left coilover: frame end, and its end on the left arm (the right mirrors). */
  readonly spring?: { readonly chassis: Vec3; readonly arm: Vec3 };
}

const mirror = (p: Vec3): Vec3 => vec3(-p.x, p.y, p.z);
const M: Mat3 = [-1, 0, 0, 0, 1, 0, 0, 0, 1];

function contactPoint(center: Vec3, spinAxisUnit: Vec3, radius: number): Vec3 {
  const down = normalize(sub(Y_AXIS, vec3(spinAxisUnit.x * spinAxisUnit.y, spinAxisUnit.y * spinAxisUnit.y, spinAxisUnit.z * spinAxisUnit.y)));
  return sub(center, vec3(down.x * radius, down.y * radius, down.z * radius));
}

export class TwistBeam {
  private readonly B: Vec3;
  private readonly S: Vec3;

  constructor(readonly geometry: TwistBeamGeometry) {
    const g = geometry;
    this.B = g.bushing;
    this.S = vec3(0, g.shearCenter.y, g.shearCenter.z);
    if (Math.abs(g.wheel.center.x) < 1e-6) throw new Error('Degenerate geometry: the wheel center is on the centerline');
    if (Math.abs(this.B.x) < 1e-6) throw new Error('Degenerate geometry: the arm bushing is on the centerline');
    if (dist(this.B, this.S) < 1e-6) throw new Error('Degenerate geometry: the arm bushing and the beam shear center coincide');
  }

  /** The left arm's rotation for heave θ and twist ψ (x' = B + R (x − B)). */
  private leftRotation(theta: number, psi: number): Mat3 {
    const H = fromAxisAngle(X_AXIS, theta);
    const P = add(this.B, mulVec(H, sub(this.S, this.B)));
    return mul(fromAxisAngle(normalize(sub(P, this.B)), psi), H);
  }

  private place(theta: number, psi: number) {
    const B = this.B;
    const RL = this.leftRotation(theta, psi);
    const RR = mul(M, mul(this.leftRotation(theta, -psi), M)); // the right arm: mirrored, twisted the other way
    const BR = mirror(B);
    return {
      RL, RR,
      left: (x: Vec3) => add(B, mulVec(RL, sub(x, B))),
      right: (x: Vec3) => add(BR, mulVec(RR, sub(x, BR))),
      poses: {
        chassis: { position: vec3(0, 0, 0), rotation: IDENTITY },
        armL: { position: sub(B, mulVec(RL, B)), rotation: RL },
        armR: { position: sub(BR, mulVec(RR, BR)), rotation: RR },
      } as Poses,
    };
  }

  design(): AxleState { return this.solve({}); }

  solve(inputs: { left?: number; right?: number }, _initial?: Poses): AxleState {
    const g = this.geometry, wc = g.wheel.center, wcR = mirror(wc);
    const qL = inputs.left ?? 0, qR = inputs.right ?? 0;
    const res = (t: number, p: number) => {
      const pl = this.place(t, p);
      return [pl.left(wc).y - (wc.y + qL), pl.right(wcR).y - (wcR.y + qR)] as const;
    };
    // Start from the small-angle estimate (arm length in side view), then Newton with a numeric Jacobian.
    const arm = Math.max(Math.hypot(wc.y - this.B.y, wc.z - this.B.z), 1);
    let t = Math.asin(Math.max(-1, Math.min(1, (qL + qR) / 2 / arm))) * Math.sign(this.B.z - wc.z || 1);
    let p = 0;
    let r = res(t, p), it = 0, ok = false;
    for (; it < 40; it++) {
      if (Math.hypot(r[0], r[1]) < 1e-9) { ok = true; break; }
      const h = 1e-7;
      const rt = res(t + h, p), rp = res(t, p + h);
      const a = (rt[0] - r[0]) / h, b = (rp[0] - r[0]) / h, c = (rt[1] - r[1]) / h, d = (rp[1] - r[1]) / h;
      const det = a * d - b * c;
      if (Math.abs(det) < 1e-14) break;
      t -= (d * r[0] - b * r[1]) / det;
      p -= (-c * r[0] + a * r[1]) / det;
      r = res(t, p);
    }
    if (!ok && Math.hypot(r[0], r[1]) < 1e-6) ok = true;
    const pl = this.place(t, p);
    const spinL = normalize(g.wheel.spinAxis);
    const wheel = (center: Vec3, R: Mat3, spin: Vec3): AxleWheel => {
      const spinAxis = normalize(mulVec(R, spin));
      return { center, spinAxis, contact: contactPoint(center, spinAxis, g.wheel.radius) };
    };
    const left = wheel(pl.left(wc), pl.RL, spinL), right = wheel(pl.right(wcR), pl.RR, mirror(spinL));
    const sp = g.spring;
    const rms = Math.hypot(r[0], r[1]) / Math.SQRT2;
    return {
      inputs: { left: qL, right: qR },
      solve: { status: ok ? 'converged' : 'not-converged', poses: pl.poses, iterations: it, residualRms: rms, equations: 2, unknowns: 2, rank: 2, conditioning: 1 },
      poses: pl.poses,
      bodies: { left: 'armL', right: 'armR' },
      left, right,
      links: [
        { name: 'arm (left)', chassis: this.B, axle: pl.left(wc) },
        { name: 'arm (right)', chassis: mirror(this.B), axle: pl.right(wcR) },
      ],
      twist: { heave: t, twist: p, shearCenter: pl.left(this.S) },
      ...(sp ? { springLength: { left: length(sub(pl.left(sp.arm), sp.chassis)), right: length(sub(pl.right(mirror(sp.arm)), mirror(sp.chassis))) } } : {}),
    };
  }
}
