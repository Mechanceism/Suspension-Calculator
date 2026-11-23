/**
 * Pre-computed solid-axle kinematics (L6): the axle solved once on a grid of left / right wheel travel and
 * interpolated with a tensor Catmull–Rom spline (smooth values and both partial derivatives).
 *
 * Each wheel's sample is given in its corner's frame (the right wheel mirrored in X, as for independent
 * corners), so the vehicle solve treats the two wheels as corners whose motion also depends on the other
 * side's travel: `dwcX`, `dcpmX`, `dLX` are the derivatives with respect to the other side's travel.
 */
import { type Vec3, vec3, add, sub, normalize } from '../math/vec3';
import { mulVec, transpose } from '../math/mat3';
import type { TwoTravelAxle, AxleState } from '../suspension/solidAxle';
import type { CornerSampleAt } from './cornerTable';

export interface AxleSampleAt extends CornerSampleAt {
  /** Derivatives with respect to the other side's travel (per mm). */
  dwcX: Vec3;
  dcpmX: Vec3;
  dLX: number;
  /** The tracked extra point's (e.g. a drop-link mount's) derivative with respect to the other side's travel. */
  dexX: Vec3;
}

/**
 * Per wheel: wc(3) cp(3) axis(3) L(1) material-contact velocity w.r.t. left(3) and right(3) travel, and an
 * extra point fixed to the axle (or to that wheel's twist-beam arm), e.g. an anti-roll bar's drop-link mount (3).
 */
const W = 19;
const mirror = (v: Vec3): Vec3 => vec3(-v.x, v.y, v.z);

export class AxleTable {
  readonly lo: number;
  readonly hi: number;
  private readonly step: number;
  private readonly n: number;
  private readonly data: Float64Array;

  /** Whether an extra point is tracked (else `ex` is the wheel center). */
  readonly hasExtra: boolean;

  /**
   * `extra`: a point (left side, design position) fixed to the axle (a solid axle) or to the left arm (a
   * twist beam; the right one is mirrored), tracked through both travels, e.g. a drop-link mount.
   */
  constructor(axle: TwoTravelAxle, range: [number, number], n = 17, rack = 0, extra?: Vec3) {
    this.hasExtra = !!extra;
    this.n = n;
    this.lo = range[0];
    this.hi = range[1];
    this.step = (range[1] - range[0]) / (n - 1);
    const qs = Array.from({ length: n }, (_, i) => range[0] + this.step * i);
    // Solve the grid, warm-starting from the neighbour.
    const states: AxleState[][] = [];
    let rowStart = axle.solve({ rack }).poses;
    for (let i = 0; i < n; i++) {
      const row: AxleState[] = [];
      let prev = rowStart;
      for (let j = 0; j < n; j++) {
        const s = axle.solve({ left: qs[i]!, right: qs[j]!, rack }, prev);
        if (s.solve.status !== 'converged' && s.solve.status !== 'singular') throw new Error(`The axle can't reach travel ${qs[i]!.toFixed(0)} / ${qs[j]!.toFixed(0)} mm`);
        row.push(s);
        prev = s.poses;
      }
      rowStart = row[0]!.poses;
      states.push(row);
    }
    // Where a point fixed to the body carrying a wheel (design-frame local position) is in a state.
    const pose = (s: AxleState, side: 0 | 1) => s.poses[s.bodies ? (side === 0 ? s.bodies.left : s.bodies.right) : 'axle']!;
    const world = (s: AxleState, side: 0 | 1, local: Vec3) => add(pose(s, side).position, mulVec(pose(s, side).rotation, local));
    const localOf = (s: AxleState, side: 0 | 1, p: Vec3) => mulVec(transpose(pose(s, side).rotation), sub(p, pose(s, side).position));
    // The extra point is carried by the axle itself (not a steered axle's knuckle), or by that side's arm.
    const mount = (s: AxleState, side: 0 | 1) => s.poses.axle ?? pose(s, side);
    const design = axle.solve({ rack });
    const exLocal = extra ? ([0, 1] as const).map((side) => {
      const m = mount(design, side), q = side === 0 ? extra : mirror(extra);
      return mulVec(transpose(m.rotation), sub(q, m.position));
    }) : null;
    this.data = new Float64Array(n * n * 2 * W);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const s = states[i]![j]!;
        for (const side of [0, 1] as const) {
          const w = side === 0 ? s.left : s.right;
          const L = s.springLength ? (side === 0 ? s.springLength.left : s.springLength.right) : NaN;
          // Material point at the contact: follow it to the neighbours in each travel.
          const loc = localOf(s, side, w.contact);
          const d = (a: AxleState, b: AxleState, dq: number) => { const pa = world(a, side, loc), pb = world(b, side, loc); return vec3((pb.x - pa.x) / dq, (pb.y - pa.y) / dq, (pb.z - pa.z) / dq); };
          const iA = Math.max(0, i - 1), iB = Math.min(n - 1, i + 1), jA = Math.max(0, j - 1), jB = Math.min(n - 1, j + 1);
          let dL_ = d(states[iA]![j]!, states[iB]![j]!, qs[iB]! - qs[iA]!);
          let dR_ = d(states[i]![jA]!, states[i]![jB]!, qs[jB]! - qs[jA]!);
          let wc = w.center, cp = w.contact, ax = w.spinAxis;
          let ex = exLocal ? add(mount(s, side).position, mulVec(mount(s, side).rotation, exLocal[side]!)) : w.center;
          if (side === 1) { wc = mirror(wc); cp = mirror(cp); ax = mirror(ax); dL_ = mirror(dL_); dR_ = mirror(dR_); ex = mirror(ex); }
          this.data.set([wc.x, wc.y, wc.z, cp.x, cp.y, cp.z, ax.x, ax.y, ax.z, L, dL_.x, dL_.y, dL_.z, dR_.x, dR_.y, dR_.z, ex.x, ex.y, ex.z], ((i * n + j) * 2 + side) * W);
        }
      }
    }
  }

  /** One wheel at its own travel and the other side's (clamped to the grid). */
  at(side: 'L' | 'R', qSelf: number, qOther: number): AxleSampleAt {
    const qL = side === 'L' ? qSelf : qOther, qR = side === 'L' ? qOther : qSelf;
    const s = side === 'L' ? 0 : 1;
    const loc = (q: number) => {
      const f = (Math.min(this.hi, Math.max(this.lo, q)) - this.lo) / this.step;
      const i = Math.min(this.n - 2, Math.max(0, Math.floor(f)));
      return { i, t: f - i };
    };
    const a = loc(qL), b = loc(qR);
    // Samples past an end are extrapolated linearly from the last two along that travel (repeating the end
    // sample would halve the slopes there).
    const n = this.n;
    const at = (ii: number, jj: number, k: number): number => {
      if (ii < 0) return 2 * at(0, jj, k) - at(Math.min(1, n - 1), jj, k);
      if (ii > n - 1) return 2 * at(n - 1, jj, k) - at(Math.max(0, n - 2), jj, k);
      if (jj < 0) return 2 * at(ii, 0, k) - at(ii, Math.min(1, n - 1), k);
      if (jj > n - 1) return 2 * at(ii, n - 1, k) - at(ii, Math.max(0, n - 2), k);
      return this.data[((ii * n + jj) * 2 + s) * W + k]!;
    };
    const val = new Array<number>(W).fill(0), dA = new Array<number>(W).fill(0), dB = new Array<number>(W).fill(0);
    // Catmull–Rom weights and their derivatives.
    const w = (t: number) => [(-t + 2 * t * t - t * t * t) / 2, (2 - 5 * t * t + 3 * t * t * t) / 2, (t + 4 * t * t - 3 * t * t * t) / 2, (-t * t + t * t * t) / 2];
    const wd = (t: number) => [(-1 + 4 * t - 3 * t * t) / 2, (-10 * t + 9 * t * t) / 2, (1 + 8 * t - 9 * t * t) / 2, (-2 * t + 3 * t * t) / 2];
    const wa = w(a.t), wda = wd(a.t), wb = w(b.t), wdb = wd(b.t);
    for (let u = 0; u < 4; u++) {
      const ii = a.i - 1 + u;
      for (let v = 0; v < 4; v++) {
        const jj = b.i - 1 + v;
        for (let k = 0; k < W; k++) {
          const P = at(ii, jj, k);
          val[k]! += wa[u]! * wb[v]! * P;
          dA[k]! += wda[u]! * wb[v]! * P;
          dB[k]! += wa[u]! * wdb[v]! * P;
        }
      }
    }
    for (let k = 0; k < W; k++) { dA[k]! /= this.step; dB[k]! /= this.step; }
    const own = side === 'L' ? dA : dB, other = side === 'L' ? dB : dA;
    const v3 = (arr: number[], o: number) => vec3(arr[o]!, arr[o + 1]!, arr[o + 2]!);
    const wc = v3(val, 0);
    // Material-contact velocities were stored per travel: left (10–12), right (13–15).
    const cpmL = v3(val, 10), cpmR = v3(val, 13);
    return {
      wc, cp: v3(val, 3), axis: normalize(v3(val, 6)), L: val[9]!, ex: v3(val, 16),
      dwc: v3(own, 0), dcp: v3(own, 3), dcpm: side === 'L' ? cpmL : cpmR, dL: own[9]!, dex: v3(own, 16),
      dwcX: v3(other, 0), dcpmX: side === 'L' ? cpmR : cpmL, dLX: other[9]!, dexX: v3(other, 16),
    };
  }
}

/** A one-travel view of an axle wheel (other side held at the same travel): for limits and quick looks. */
export class AxleCornerTable {
  constructor(readonly axle: AxleTable, readonly side: 'L' | 'R') {}
  get lo() { return this.axle.lo; }
  get hi() { return this.axle.hi; }
  at(q: number): CornerSampleAt { return this.axle.at(this.side, q, q); }
}
