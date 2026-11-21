/**
 * Pre-computed corner kinematics (L6).
 *
 * A corner has one degree of freedom (travel q) for a given rack position. The vehicle solve
 * evaluates corners thousands of times, so each corner is solved once on a grid of q and then
 * interpolated with a Catmull–Rom spline (smooth values and derivatives) — fast and accurate.
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
  /** Derivatives with respect to q (per mm of wheel-center travel). */
  dwc: Vec3;
  dcp: Vec3;
  dL: number;
}

const K = 10; // wc(3) cp(3) axis(3) L(1)

export class CornerTable {
  readonly lo: number;
  readonly hi: number;
  private readonly step: number;
  private readonly data: Float64Array;
  private readonly n: number;

  /**
   * @param range wheel-center travel range to tabulate (mm); trimmed if the linkage can't reach it
   * @param n     number of grid points
   */
  constructor(corner: DoubleWishbone, rack: number, range: [number, number], n = 41) {
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
      this.data.set([p.wheelCenter.x, p.wheelCenter.y, p.wheelCenter.z, p.contact.x, p.contact.y, p.contact.z,
        s.spinAxis.x, s.spinAxis.y, s.spinAxis.z, L ?? NaN], i * K);
    }
  }

  /** Interpolated values and derivatives at travel q (clamped to the table range). */
  at(q: number): CornerSampleAt {
    const qq = Math.min(this.hi, Math.max(this.lo, q));
    const f = (qq - this.lo) / this.step;
    const i = Math.min(this.n - 2, Math.max(0, Math.floor(f)));
    const t = f - i;
    const idx = (j: number) => Math.min(this.n - 1, Math.max(0, j)) * K;
    const i0 = idx(i - 1), i1 = idx(i), i2 = idx(i + 1), i3 = idx(i + 2);
    const val = new Array<number>(K);
    const der = new Array<number>(K);
    const t2 = t * t, t3 = t2 * t;
    for (let k = 0; k < K; k++) {
      const P0 = this.data[i0 + k]!, P1 = this.data[i1 + k]!, P2 = this.data[i2 + k]!, P3 = this.data[i3 + k]!;
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
      dwc: vec3(der[0]!, der[1]!, der[2]!),
      dcp: vec3(der[3]!, der[4]!, der[5]!),
      dL: der[9]!,
    };
  }
}
