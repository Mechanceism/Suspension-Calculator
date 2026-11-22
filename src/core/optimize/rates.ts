/**
 * Tune springs, dampers and anti-roll bars on the tests driven over time (Phase B), by Bayesian
 * optimization (search.ts): each evaluation runs every test with the candidate rates (steady states and
 * the ride), scores it (tests/score.ts, priority-weighted) and the Gaussian process picks the next
 * candidate. Rates are searched on a log scale (a spring twice as stiff is as far as one half as stiff).
 * The current design is the first candidate, so the result is never worse than where it started.
 */
import type { CornerId } from '../vehicle/vehicle';
import type { VehicleProblem } from './vehicle';
import { runTest, type TestRun, type TestSegmentSpec } from '../tests/run';
import { testScore } from '../tests/score';
import { BayesOpt } from './search';

export type RateKind = 'spring' | 'bump' | 'rebound' | 'bumpHigh' | 'reboundHigh' | 'arb';

export interface RateVar {
  kind: RateKind;
  /** Design (root corner) for springs and dampers; axle for anti-roll bars. */
  root?: CornerId;
  axle?: 'front' | 'rear';
  /** Range and current value, in the problem's units (N/mm, N·s/m; bars: N/mm at the wheel or N·mm/rad). */
  lo: number;
  hi: number;
  value: number;
  label: string;
}

export interface RateTest { segments: TestSegmentSpec[]; weight: number; onFail: 'report' | 'lift' }

/** The problem with these rates. */
export function withRates(p: VehicleProblem, vars: RateVar[], x: number[]): VehicleProblem {
  const designs = Object.fromEntries(Object.entries(p.designs).map(([k, d]) => [k, { ...d!, damping: d!.damping ? { ...d!.damping } : undefined }])) as VehicleProblem['designs'];
  const shared = { front: { ...p.shared.front }, rear: { ...p.shared.rear } };
  vars.forEach((v, i) => {
    const val = x[i]!;
    if (v.kind === 'arb' && v.axle) {
      const a = shared[v.axle].antiRollBar;
      shared[v.axle] = { ...shared[v.axle], antiRollBar: a.kind === 'wheelRate' ? { ...a, rate: val } : a.kind === 'torsionBar' ? { ...a, barRate: val } : a };
      return;
    }
    const d = v.root ? designs[v.root] : undefined;
    if (!d) return;
    if (v.kind === 'spring') d.springRate = val;
    else {
      const dm = d.damping ?? { bump: 0, rebound: 0 };
      d.damping = { ...dm, [v.kind]: val };
    }
  });
  return { ...p, designs, shared };
}

const geometriesOf = (p: VehicleProblem) => Object.fromEntries(Object.entries(p.designs).map(([r, d]) => [r, d!.geometry]));

/** Score of a set of tests (priority-weighted mean of each test's score) with its runs. */
export function scoreTests(p: VehicleProblem, tests: RateTest[], mode: 'pass' | 'improve' = 'pass'): { score: number; runs: TestRun[] } {
  const geoms = geometriesOf(p);
  const runs = tests.map((t) => runTest(p, geoms, t.segments, { onFail: t.onFail, speedLimits: false, ride: true }));
  const tw = tests.reduce((a, t) => a + t.weight, 0) || 1;
  const score = runs.reduce((a, r, i) => a + tests[i]!.weight * (r.error ? 1e4 : testScore(r, mode)), 0) / tw;
  return { score, runs };
}

export interface RateProgress { evaluation: number; budget: number; current: number; best: number; bestX: number[] }

export interface RateResult {
  /** Best rates found (the starting values when nothing better turned up). */
  x: number[];
  before: number;
  after: number;
  evaluations: number;
  history: number[];
  stopped: boolean;
}

/** Map u ∈ [0, 1] to a rate on a log scale (linear when the range touches 0). */
const toRate = (v: RateVar, u: number) => (v.lo > 0 && v.hi > v.lo ? v.lo * (v.hi / v.lo) ** u : v.lo + (v.hi - v.lo) * u);
const toUnit = (v: RateVar, x: number) => {
  const c = Math.min(Math.max(x, Math.min(v.lo, v.hi)), Math.max(v.lo, v.hi));
  return v.lo > 0 && v.hi > v.lo ? Math.log(c / v.lo) / Math.log(v.hi / v.lo) : (c - v.lo) / ((v.hi - v.lo) || 1);
};

export function tuneRates(
  p: VehicleProblem, tests: RateTest[], vars: RateVar[], opts: { budget: number; seed?: number; mode?: 'pass' | 'improve' },
  onProgress?: (i: RateProgress) => boolean | void,
): RateResult {
  const mode = opts.mode ?? 'pass';
  const budget = Math.max(2, Math.round(opts.budget));
  const bo = new BayesOpt(vars.length, { seed: opts.seed ?? 17 });
  const x0 = vars.map((v) => v.value);
  const before = scoreTests(withRates(p, vars, x0), tests, mode).score;
  bo.observe(vars.map((v, i) => toUnit(v, x0[i]!)), before);
  const history = [before];
  let best = { x: x0, y: before };
  let stopped = false;
  for (let k = 1; k < budget; k++) {
    const u = bo.suggest();
    const x = vars.map((v, i) => toRate(v, u[i]!));
    const y = scoreTests(withRates(p, vars, x), tests, mode).score;
    bo.observe(u, y);
    history.push(y);
    if (y < best.y) best = { x, y };
    if (onProgress?.({ evaluation: k + 1, budget, current: y, best: best.y, bestX: best.x }) === false) { stopped = true; break; }
  }
  return { x: best.x, before, after: best.y, evaluations: history.length, history, stopped };
}
