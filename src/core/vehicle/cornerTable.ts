/**
 * Pre-computed corner kinematics (L6).
 *
 * A corner has one degree of freedom (travel q) for a given rack position. The vehicle solve
 * evaluates corners thousands of times, so each corner is solved once on a grid of q and then
 * interpolated with a Catmull–Rom spline (smooth values and derivatives) — fast and accurate.
 * An optional extra point fixed to an arm (e.g. an anti-roll-bar drop-link mount) is tracked too.
 */
import { type Vec3, vec3, normalize } from '../math/vec3';
import type { DoubleWishbone } from '../suspension/doubleWishbone';
import { springLength } from '../suspension/spring';

export interface CornerSampleAt {
  /** Wheel center, rigid contact point and unit spin axis (corner frame). */
  wc: Vec3;
  cp: Vec3;
  axis: Vec3;
  /** Spring mount-to-mount length (NaN if no spring). */
  L: number;
  /** Tracked extra point (corner frame), or the wheel center if none was given. */
  ex: Vec3;
  /** Derivatives with respect to q (per mm of wheel-center travel). */
  dwc: Vec3;
  /** Path of the lowest point of the wheel (slides around the tire as it rises / tilts). */
  dcp: Vec3;
  /**
   * Velocity (per mm of travel) of the material point of the wheel/upright that is touching the
   * ground. This — not the lowest-point path — is what the tire forces do virtual work through.
   */
  dcpm: Vec3;
  dL: number;
  dex: Vec3;
}

export interface TrackedPoint {
  body: 'uca' | 'lca' | 'upright' | 'rocker';
  /** Design position, corner frame. */
  point: Vec3;
}

const K = 16; // wc(3) cp(3) axis(3) L(1) ex(3) contact material velocity(3)

export class CornerTable {
  readonly lo: number;
  readonly hi: number;
  private readonly step: number;
  private readonly data: Float64Array;
  private readonly n: number;

  /**
   * @param range wheel-center travel range to tabulate (mm); trimmed if the linkage can't reach it
   * @param n     number of grid points
   * @param extra a point on one of the moving bodies to track through travel
   */
  constructor(corner: DoubleWishbone, rack: number, range: [number, number], n = 41, extra?: TrackedPoint) {
    const qs = Array.from({ length: n }, (_, i) => range[0] + ((range[1] - range[0]) * i) / (n - 1));
    const states = corner.sweep(qs, (q) => ({ travel: q, rack, driver: 'wheelCenter' }));
    // Keep the contiguous run of converged solutions around the design position.
    const ok = states.map((s) => s.solve.status === 'converged' || s.solve.status === 'singular');
    let a = qs.findIndex((q) => q >= 0);
    if (a < 0) a = n - 1;
    let first = a;
    let last = a;
    while (first > 0 && ok[first - 1]) first--;
    while (last < n - 1 && ok[last + 1]) last++;
    this.n = last - first + 1;
    this.lo = qs[first]!;
    this.hi = qs[last]!;
    this.step = (range[1] - range[0]) / (n - 1);
    this.data = new Float64Array(this.n * K);
    for (let i = 0; i < this.n; i++) {
      const s = states[first + i]!;
      const p = s.points;
      const L = springLength(s);
      const ex = extra ? corner.pointOn(s, extra.body, extra.point) : p.wheelCenter;
      // Material velocity of the upright point at the contact: follow that point to the neighbours.
      const iA = Math.max(first, first + i - 1);
      const iB = Math.min(last, first + i + 1);
      const material = corner.designPointOf(s, 'upright', p.contact);
      const pa = corner.pointOn(states[iA]!, 'upright', material);
      const pb = corner.pointOn(states[iB]!, 'upright', material);
      const dq = qs[iB]! - qs[iA]!;
      this.data.set([p.wheelCenter.x, p.wheelCenter.y, p.wheelCenter.z, p.contact.x, p.contact.y, p.contact.z,
        s.spinAxis.x, s.spinAxis.y, s.spinAxis.z, L ?? NaN, ex.x, ex.y, ex.z,
        (pb.x - pa.x) / dq, (pb.y - pa.y) / dq, (pb.z - pa.z) / dq], i * K);
    }
  }

  /** Interpolated values and derivatives at travel q (clamped to the table range). */
  at(q: number): CornerSampleAt {
    const qq = Math.min(this.hi, Math.max(this.lo, q));
    const f = (qq - this.lo) / this.step;
    const i = Math.min(this.n - 2, Math.max(0, Math.floor(f)));
    const t = f - i;
    // Samples past either end are extrapolated linearly from the last two (repeating the end sample would
    // halve the slope there: a motion ratio or wheel path at full droop / bump read as half of what it is).
    const n = this.n;
    const P = (j: number, k: number): number => {
      if (j < 0) return 2 * this.data[k]! - this.data[(n > 1 ? 1 : 0) * K + k]!;
      if (j > n - 1) return 2 * this.data[(n - 1) * K + k]! - this.data[Math.max(0, n - 2) * K + k]!;
      return this.data[j * K + k]!;
    };
    const val = new Array<number>(K);
    const der = new Array<number>(K);
    const t2 = t * t, t3 = t2 * t;
    for (let k = 0; k < K; k++) {
      const P0 = P(i - 1, k), P1 = P(i, k), P2 = P(i + 1, k), P3 = P(i + 2, k);
      const a1 = -P0 + P2;
      const a2 = 2 * P0 - 5 * P1 + 4 * P2 - P3;
      const a3 = -P0 + 3 * P1 - 3 * P2 + P3;
      val[k] = 0.5 * (2 * P1 + a1 * t + a2 * t2 + a3 * t3);
      der[k] = (0.5 * (a1 + 2 * a2 * t + 3 * a3 * t2)) / this.step;
    }
    return {
      wc: vec3(val[0]!, val[1]!, val[2]!),
      cp: vec3(val[3]!, val[4]!, val[5]!),
      axis: normalize(vec3(val[6]!, val[7]!, val[8]!)),
      L: val[9]!,
      ex: vec3(val[10]!, val[11]!, val[12]!),
      dwc: vec3(der[0]!, der[1]!, der[2]!),
      dcp: vec3(der[3]!, der[4]!, der[5]!),
      dcpm: vec3(val[13]!, val[14]!, val[15]!),
      dL: der[9]!,
      dex: vec3(der[10]!, der[11]!, der[12]!),
    };
  }
}
