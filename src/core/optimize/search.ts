/**
 * Search strategies matched to how expensive one evaluation is (docs/MATH.md § Optimizer strategies):
 *
 *  - DOE: Latin-hypercube samples spread over the free ranges (each variable's range cut into n equal
 *    strata, one sample per stratum, strata shuffled per variable). Used to seed multi-start and for the
 *    sensitivity report.
 *  - Multi-start gradient search (geometry on steady states: many variables, cheap): the bounded
 *    Levenberg–Marquardt run from the current design and from the best DOE samples; the lowest cost wins.
 *  - Sensitivity ("what matters most"): a linear fit of the cost (and each goal) to the DOE samples, plus
 *    pairwise interactions of the strongest variables (a small response surface).
 *  - Bayesian optimization (springs / dampers on the ride over time: few variables, ~1 s per test): a
 *    Gaussian process models the cost from every test so far; the next test is where the expected
 *    improvement is largest.
 */
import { lsqSteps, runStepsSync, type LsqOptions, type LsqResult, type ResidualFn, type Steps } from './leastSquares';
import { solveLinear } from '../math/linalg';

/** Small, fast seeded random numbers (mulberry32). */
export function rng(seed = 1): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** n Latin-hypercube samples in [0, 1]^d. */
export function latinHypercube(n: number, d: number, rand: () => number): number[][] {
  const out = Array.from({ length: n }, () => new Array<number>(d).fill(0));
  for (let j = 0; j < d; j++) {
    const perm = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) { const k = Math.floor(rand() * (i + 1)); [perm[i], perm[k]] = [perm[k]!, perm[i]!]; }
    for (let i = 0; i < n; i++) out[i]![j] = (perm[i]! + rand()) / n;
  }
  return out;
}

const scaleTo = (u: number[], lo: number[], hi: number[]) => u.map((v, i) => lo[i]! + v * (hi[i]! - lo[i]!));
const costOf = (r: number[] | null) => (r ? 0.5 * r.reduce((a, v) => a + v * v, 0) : Infinity);

export interface MultiStartOptions {
  /** Gradient runs: from the current design plus (starts − 1) of the best DOE samples. */
  starts: number;
  /** DOE samples scanned to pick the starts (default 8 per start, at least 12). */
  samples?: number;
  seed?: number;
}

/**
 * Bounded least squares from several starts (the current design first). Progress is reported as one
 * continuous count of iterations; `start` tells which run it is.
 */
export function multiStartLeastSquares(
  f: ResidualFn, x0: number[], lo: number[], hi: number[], opts: LsqOptions, ms: MultiStartOptions,
  onStart?: (start: number, of: number) => void,
): LsqResult & { start: number; starts: number } {
  return runStepsSync(multiStartSteps(x0, lo, hi, opts, ms, onStart), f);
}

/** The steps of multiStartLeastSquares (batches of points to evaluate; see lsqSteps). */
export function* multiStartSteps(
  x0: number[], lo: number[], hi: number[], opts: LsqOptions, ms: MultiStartOptions,
  onStart?: (start: number, of: number) => void,
): Steps<LsqResult & { start: number; starts: number }> {
  const starts = Math.max(1, Math.round(ms.starts));
  const first = yield* lsqSteps(x0, lo, hi, opts);
  if (starts === 1) return { ...first, start: 0, starts: 1 };
  let stopped = first.status === 'cancelled';
  const rand = rng(ms.seed ?? 7);
  const n = Math.max(12, ms.samples ?? 8 * starts);
  const xs = latinHypercube(n, x0.length, rand).map((u) => scaleTo(u, lo, hi));
  const rs = stopped ? [] : yield xs;
  const scored = xs.map((x, i) => ({ x, cost: costOf(rs[i] ?? null) }))
    .filter((s) => Number.isFinite(s.cost)).sort((a, b) => a.cost - b.cost);
  let best = { ...first, start: 0 };
  let iterBase = first.iterations;
  for (let k = 0; k < starts - 1 && k < scored.length && !stopped; k++) {
    onStart?.(k + 1, starts);
    const r = yield* lsqSteps(scored[k]!.x, lo, hi, {
      ...opts,
      onIteration: opts.onIteration ? (i) => opts.onIteration!({ ...i, iteration: iterBase + i.iteration, cost0: first.cost0 }) : undefined,
    });
    iterBase += r.iterations;
    if (r.status === 'cancelled') stopped = true;
    if (r.cost < best.cost) best = { ...r, cost0: first.cost0, start: k + 1 };
  }
  return { ...best, starts };
}

// ---------------------------------------------------------------- sensitivity (DOE + response surface)

export interface Sensitivity {
  /** Per variable: change of the output from the low to the high end of its range (linear fit). */
  effects: { index: number; effect: number }[];
  /** Strongest pairwise interactions among the top variables (coefficient of the product, range to range). */
  interactions: { a: number; b: number; effect: number }[];
  /** Share of the output's variation the fit explains (0–1). */
  r2: number;
  samples: number;
}

/** Least-squares fit y ≈ X·β (ridge-stabilized normal equations). */
function fit(X: number[][], y: number[]): number[] | null {
  const m = X[0]?.length ?? 0;
  const A = Array.from({ length: m }, () => new Array<number>(m).fill(0));
  const b = new Array<number>(m).fill(0);
  X.forEach((row, i) => {
    for (let a = 0; a < m; a++) {
      b[a]! += row[a]! * y[i]!;
      for (let c = 0; c < m; c++) A[a]![c]! += row[a]! * row[c]!;
    }
  });
  for (let a = 0; a < m; a++) A[a]![a]! += 1e-9 * (1 + A[a]![a]!);
  return solveLinear(A, b);
}

/**
 * Sensitivity of an output to each variable from DOE samples u ∈ [0, 1]^d (coded −1…+1 for the fit).
 * Effects are the output's change across the whole range of each variable.
 */
export function sensitivity(us: number[][], ys: number[], topForInteractions = 4): Sensitivity | null {
  const ok = us.map((u, i) => ({ u, y: ys[i]! })).filter((s) => Number.isFinite(s.y));
  if (ok.length < 3) return null;
  const d = ok[0]!.u.length;
  const code = (u: number[]) => u.map((v) => 2 * v - 1);
  const rows = ok.map((s) => [1, ...code(s.u)]);
  const y = ok.map((s) => s.y);
  const beta = fit(rows, y);
  if (!beta) return null;
  const mean = y.reduce((a, v) => a + v, 0) / y.length;
  const ssTot = y.reduce((a, v) => a + (v - mean) ** 2, 0) || 1;
  const pred = (row: number[], bb: number[]) => row.reduce((a, v, i) => a + v * bb[i]!, 0);
  let r2 = 1 - rows.reduce((a, row, i) => a + (y[i]! - pred(row, beta)) ** 2, 0) / ssTot;
  let effects = Array.from({ length: d }, (_, j) => ({ index: j, effect: 2 * beta[j + 1]! })).sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
  // Interactions among the strongest variables, when there are enough samples.
  const top = effects.slice(0, Math.min(topForInteractions, d)).map((e) => e.index);
  const pairs: [number, number][] = [];
  for (let a = 0; a < top.length; a++) for (let b = a + 1; b < top.length; b++) pairs.push([top[a]!, top[b]!]);
  let interactions: Sensitivity['interactions'] = [];
  if (pairs.length && ok.length > d + 1 + pairs.length + 2) {
    const rows2 = ok.map((s) => { const c = code(s.u); return [1, ...c, ...pairs.map(([a, b]) => c[a]! * c[b]!)]; });
    const beta2 = fit(rows2, y);
    if (beta2) {
      interactions = pairs.map(([a, b], k) => ({ a, b, effect: 2 * beta2[d + 1 + k]! })).sort((p, q) => Math.abs(q.effect) - Math.abs(p.effect));
      // Main effects from the fuller model (the products no longer bias them).
      effects = Array.from({ length: d }, (_, j) => ({ index: j, effect: 2 * beta2[j + 1]! })).sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
      r2 = Math.max(r2, 1 - rows2.reduce((acc, row, i) => acc + (y[i]! - pred(row, beta2)) ** 2, 0) / ssTot);
    }
  }
  return { effects, interactions, r2: Math.max(0, Math.min(1, r2)), samples: ok.length };
}

// ---------------------------------------------------------------- Bayesian optimization

/** Matérn 5/2 kernel on distance r with length scale l. */
const matern52 = (r: number, l: number) => { const s = (Math.sqrt(5) * r) / l; return (1 + s + (s * s) / 3) * Math.exp(-s); };

function cholesky(A: number[][]): number[][] | null {
  const n = A.length;
  const L = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i]![j]!;
      for (let k = 0; k < j; k++) s -= L[i]![k]! * L[j]![k]!;
      if (i === j) { if (!(s > 0)) return null; L[i]![i] = Math.sqrt(s); } else L[i]![j] = s / L[j]![j]!;
    }
  }
  return L;
}
const solveL = (L: number[][], b: number[]) => { const n = b.length; const x = new Array<number>(n).fill(0); for (let i = 0; i < n; i++) { let s = b[i]!; for (let k = 0; k < i; k++) s -= L[i]![k]! * x[k]!; x[i] = s / L[i]![i]!; } return x; };
const solveLT = (L: number[][], b: number[]) => { const n = b.length; const x = new Array<number>(n).fill(0); for (let i = n - 1; i >= 0; i--) { let s = b[i]!; for (let k = i + 1; k < n; k++) s -= L[k]![i]! * x[k]!; x[i] = s / L[i]![i]!; } return x; };
const dist = (a: number[], b: number[]) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]!) ** 2, 0));
const normPdf = (z: number) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
const normCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));
function erf(x: number) {
  // Abramowitz–Stegun 7.1.26
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}

/**
 * Bayesian optimization (minimizing) over [0, 1]^d. Call suggest() for the next point to test and
 * observe() with its cost. The first points are a Latin hypercube (plus any points observed up front,
 * such as the current design); then a Gaussian process (Matérn 5/2, length scale by maximum likelihood)
 * picks the point with the largest expected improvement.
 */
export class BayesOpt {
  readonly xs: number[][] = [];
  readonly ys: number[] = [];
  private readonly rand: () => number;
  private readonly initial: number[][];
  private served = 0;

  constructor(readonly dim: number, opts: { seed?: number; initial?: number } = {}) {
    this.rand = rng(opts.seed ?? 11);
    this.initial = latinHypercube(Math.max(4, opts.initial ?? Math.min(2 * dim + 2, 12)), dim, this.rand);
  }

  observe(x: number[], y: number) {
    this.xs.push(x.map((v) => Math.min(1, Math.max(0, v))));
    // Failed evaluations count as a bad (but finite) cost so the model steers away.
    const finite = this.ys.filter(Number.isFinite);
    this.ys.push(Number.isFinite(y) ? y : (finite.length ? Math.max(...finite) * 1.5 + 1 : 1e6));
  }

  best(): { x: number[]; y: number } | null {
    if (!this.ys.length) return null;
    let k = 0;
    this.ys.forEach((y, i) => { if (y < this.ys[k]!) k = i; });
    return { x: this.xs[k]!, y: this.ys[k]! };
  }

  suggest(): number[] {
    if (this.served < this.initial.length) return this.initial[this.served++]!;
    const model = this.model();
    if (!model) return Array.from({ length: this.dim }, () => this.rand());
    const yBest = Math.min(...model.yn);
    const ei = (x: number[]) => {
      const { mu, sd } = model.predict(x);
      if (sd < 1e-9) return 0;
      const z = (yBest - mu - 0.01) / sd;
      return (yBest - mu - 0.01) * normCdf(z) + sd * normPdf(z);
    };
    // Random candidates plus perturbations of the best points, then a short local polish.
    const cands: number[][] = [];
    for (let i = 0; i < 1500; i++) cands.push(Array.from({ length: this.dim }, () => this.rand()));
    const order = this.ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y).slice(0, 5);
    for (const { i } of order) for (let k = 0; k < 60; k++) cands.push(this.xs[i]!.map((v) => Math.min(1, Math.max(0, v + (this.rand() - 0.5) * 0.2))));
    let bestX = cands[0]!, bestEi = -Infinity;
    for (const c of cands) { const e = ei(c); if (e > bestEi) { bestEi = e; bestX = c; } }
    let step = 0.05;
    for (let it = 0; it < 30; it++) {
      const c = bestX.map((v) => Math.min(1, Math.max(0, v + (this.rand() - 0.5) * 2 * step)));
      const e = ei(c);
      if (e > bestEi) { bestEi = e; bestX = c; } else step *= 0.9;
    }
    return bestX;
  }

  /**
   * q points to test together (in parallel): each one is suggested as if the ones before it had come
   * back at the best cost so far ("constant liar"), so they spread out instead of piling up.
   */
  suggestBatch(q: number): number[][] {
    const out: number[][] = [];
    const lie = this.ys.length ? Math.min(...this.ys) : 0;
    for (let k = 0; k < Math.max(1, q); k++) {
      const u = this.suggest();
      out.push(u);
      this.xs.push(u.map((v) => Math.min(1, Math.max(0, v))));
      this.ys.push(lie);
    }
    this.xs.splice(this.xs.length - out.length);
    this.ys.splice(this.ys.length - out.length);
    return out;
  }

  /** Gaussian process on the standardized costs, length scale by maximum likelihood over a grid. */
  private model() {
    const n = this.xs.length;
    const mean = this.ys.reduce((a, v) => a + v, 0) / n;
    const sdv = Math.sqrt(this.ys.reduce((a, v) => a + (v - mean) ** 2, 0) / n) || 1;
    const yn = this.ys.map((v) => (v - mean) / sdv);
    const noise = 1e-4;
    let best: { l: number; L: number[][]; alpha: number[]; ll: number } | null = null;
    for (const f of [0.08, 0.12, 0.18, 0.27, 0.4, 0.6, 0.9, 1.3]) {
      const l = f * Math.sqrt(this.dim);
      const K = this.xs.map((a, i) => this.xs.map((b, j) => matern52(dist(a, b), l) + (i === j ? noise : 0)));
      const L = cholesky(K);
      if (!L) continue;
      const alpha = solveLT(L, solveL(L, yn));
      const ll = -0.5 * yn.reduce((a, v, i) => a + v * alpha[i]!, 0) - L.reduce((a, row, i) => a + Math.log(row[i]!), 0);
      if (!best || ll > best.ll) best = { l, L, alpha, ll };
    }
    if (!best) return null;
    const { l, L, alpha } = best;
    return {
      yn,
      predict: (x: number[]) => {
        const k = this.xs.map((a) => matern52(dist(a, x), l));
        const mu = k.reduce((a, v, i) => a + v * alpha[i]!, 0);
        const v = solveL(L, k);
        const varr = Math.max(1e-12, 1 + noise - v.reduce((a, q) => a + q * q, 0));
        return { mu, sd: Math.sqrt(varr) };
      },
    };
  }
}
