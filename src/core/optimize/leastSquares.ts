/**
 * Bounded nonlinear least squares (L7): minimize ½·Σ rᵢ(x)² subject to lo ≤ x ≤ hi.
 *
 * Levenberg–Marquardt with a forward-difference Jacobian and a projected step: variables sitting
 * on a bound whose gradient pushes them further out are held for that step (a simple active set),
 * the rest take the damped Gauss–Newton step, and the result is clipped to the box. The residual
 * function may return null (e.g. the linkage can't be assembled); that point counts as infinitely
 * bad, so the step is rejected and the damping raised.
 *
 * The algorithm is a generator (`lsqSteps`) that yields batches of points to evaluate, so the same steps
 * run either here, one point after another (`boundedLeastSquares`), or spread over several workers
 * (`runSteps` with an async batch evaluator: the Jacobian's columns at once, and with `parallel` > 1
 * several damping trials at once). With `parallel` = 1 both give exactly the same result.
 */
import { solveLinear } from '../math/linalg';

export type ResidualFn = (x: number[]) => number[] | null;

export interface LsqOptions {
  maxIterations?: number;
  /** Finite-difference step per variable (same units as x). Default 0.01. */
  step?: number;
  /** Stop when an accepted step lowers the cost by less than this fraction. Default 1e-6. */
  relTol?: number;
  /** Stop when every variable moves less than this in a step. Default 1e-5. */
  xTol?: number;
  /**
   * Damping trials evaluated together (default 1). More use more evaluations but fewer rounds when the
   * points are evaluated in parallel; the result is the same as with one at a time.
   */
  parallel?: number;
  /** Called after each iteration; return false to stop early. */
  onIteration?: (info: { iteration: number; cost: number; cost0: number; x: number[]; evaluations: number }) => boolean | void;
}

export interface LsqResult {
  x: number[];
  /** ½·Σr² at the start and at the end. */
  cost0: number;
  cost: number;
  iterations: number;
  evaluations: number;
  status: 'converged' | 'max-iterations' | 'stalled' | 'cancelled' | 'infeasible-start';
  /** Variables that ended on a bound (−1 = at lo, +1 = at hi, 0 = inside). */
  atBound: number[];
  history: number[];
}

const half2 = (r: number[]) => 0.5 * r.reduce((a, v) => a + v * v, 0);

/** A batch of points to evaluate; the generator receives their residuals (null = can't be evaluated). */
export type Batch = number[][];
export type BatchResult = (number[] | null)[];
export type Steps<R> = Generator<Batch, R, BatchResult>;

/** Run steps one point at a time. */
export function runStepsSync<R>(g: Steps<R>, f: ResidualFn): R {
  let s = g.next();
  while (!s.done) s = g.next(s.value.map((x) => f(x)));
  return s.value;
}

/** Run steps with a batch evaluator (e.g. a pool of workers). */
export async function runSteps<R>(g: Steps<R>, f: (xs: Batch) => Promise<BatchResult>): Promise<R> {
  let s = g.next();
  while (!s.done) s = g.next(await f(s.value));
  return s.value;
}

export function boundedLeastSquares(f: ResidualFn, x0: number[], lo: number[], hi: number[], opts: LsqOptions = {}): LsqResult {
  return runStepsSync(lsqSteps(x0, lo, hi, opts), f);
}

export function* lsqSteps(x0: number[], lo: number[], hi: number[], opts: LsqOptions = {}): Steps<LsqResult> {
  const n = x0.length;
  const maxIt = opts.maxIterations ?? 60;
  const h = opts.step ?? 0.01;
  const relTol = opts.relTol ?? 1e-6;
  const xTol = opts.xTol ?? 1e-5;
  const par = Math.max(1, Math.round(opts.parallel ?? 1));
  const clip = (v: number, i: number) => Math.min(hi[i]!, Math.max(lo[i]!, v));
  let evaluations = 0;
  const ok = (r: number[] | null | undefined) => (r && r.every(Number.isFinite) ? r : null);
  function* evalMany(xs: number[][]): Steps<(number[] | null)[]> {
    if (!xs.length) return [];
    evaluations += xs.length;
    const rs = yield xs;
    return xs.map((_, i) => ok(rs[i]));
  }

  let x = x0.map(clip);
  let r = (yield* evalMany([x]))[0]!;
  const bounds = (xx: number[]) => xx.map((v, i) => (v <= lo[i]! + 1e-12 ? -1 : v >= hi[i]! - 1e-12 ? 1 : 0));
  if (!r) return { x, cost0: Infinity, cost: Infinity, iterations: 0, evaluations, status: 'infeasible-start', atBound: bounds(x), history: [] };
  const cost0 = half2(r);
  let cost = cost0;
  const history = [cost];
  let lambda = 1e-3;
  let status: LsqResult['status'] = 'max-iterations';
  let it = 0;

  for (; it < maxIt; it++) {
    if (cost === 0) { status = 'converged'; break; }
    // Jacobian columns by forward differences (stepping inward at the upper bound), all in one batch;
    // a column that can't be evaluated tries the other side in a second batch.
    const m = r.length;
    const J: number[][] = Array.from({ length: m }, () => new Array<number>(n).fill(0));
    const fwd = x.map((v, j) => { const xp = x.slice(); xp[j] = v + (v + h > hi[j]! ? -h : h); return xp; });
    const rf = yield* evalMany(fwd);
    const retry = rf.map((rp, j) => {
      if (rp) return null;
      const xp = x.slice(); xp[j] = clip(x[j]! - (fwd[j]![j]! - x[j]!), j);
      return xp[j] !== x[j] ? xp : null;
    });
    const rr = yield* evalMany(retry.filter((v): v is number[] => !!v));
    let k = 0;
    for (let j = 0; j < n; j++) {
      let xp = fwd[j]!, rp = rf[j]!;
      if (!rp && retry[j]) { xp = retry[j]!; rp = rr[k++]!; }
      if (!rp || rp.length !== m) continue;
      const d = xp[j]! - x[j]!;
      for (let i = 0; i < m; i++) J[i]![j] = (rp[i]! - r[i]!) / d;
    }
    // Normal equations: g = Jᵀr, A = JᵀJ.
    const g = new Array<number>(n).fill(0);
    const A: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    for (let i = 0; i < m; i++) {
      const Ji = J[i]!;
      for (let a = 0; a < n; a++) {
        if (Ji[a] === 0) continue;
        g[a]! += Ji[a]! * r[i]!;
        for (let b = a; b < n; b++) A[a]![b]! += Ji[a]! * Ji[b]!;
      }
    }
    for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) A[a]![b] = A[b]![a]!;
    // Active set: on a bound and the descent direction (−g) points outward.
    const free = x.map((v, i) => !((v <= lo[i]! + 1e-12 && g[i]! > 0) || (v >= hi[i]! - 1e-12 && g[i]! < 0)));
    const idx = free.map((fr, i) => (fr ? i : -1)).filter((i) => i >= 0);
    if (!idx.length || Math.max(...idx.map((i) => Math.abs(g[i]!))) < 1e-12) { status = 'converged'; break; }

    // Damping trials, the same sequence as one at a time (λ ×4 after a rejected step, ×10 when the
    // system can't be solved), `par` of them per batch; the first acceptable one in order wins.
    let accepted = false;
    let tries = 0;
    while (tries < 12 && !accepted) {
      const cands: { xn: number[]; lam: number }[] = [];
      let lam = lambda;
      while (tries < 12 && cands.length < par) {
        tries++;
        const Ar = idx.map((a) => idx.map((b) => A[a]![b]! + (a === b ? lam * (A[a]![a]! + 1e-9) : 0)));
        const d = solveLinear(Ar, idx.map((a) => -g[a]!));
        if (!d) { lam *= 10; continue; }
        const xn = x.slice();
        idx.forEach((a, q) => { xn[a] = clip(x[a]! + d[q]!, a); });
        cands.push({ xn, lam });
        lam *= 4;
      }
      lambda = lam;
      const rs = yield* evalMany(cands.map((c) => c.xn));
      for (let q = 0; q < cands.length; q++) {
        const rn = rs[q]!;
        const cn = rn ? half2(rn) : Infinity;
        if (rn && cn < cost) {
          const xn = cands[q]!.xn;
          const moved = Math.max(...xn.map((v, i) => Math.abs(v - x[i]!)));
          const rel = (cost - cn) / Math.max(cost, 1e-300);
          x = xn; r = rn; cost = cn;
          lambda = Math.max(cands[q]!.lam / 3, 1e-9);
          accepted = true;
          history.push(cost);
          if (rel < relTol || moved < xTol) status = 'converged';
          break;
        }
      }
    }
    const keepGoing = opts.onIteration?.({ iteration: it + 1, cost, cost0, x: x.slice(), evaluations });
    if (keepGoing === false) { status = 'cancelled'; it++; break; }
    if (!accepted) { status = 'stalled'; it++; break; }
    if (status === 'converged') { it++; break; }
  }
  return { x, cost0, cost, iterations: it, evaluations, status, atBound: bounds(x), history };
}
