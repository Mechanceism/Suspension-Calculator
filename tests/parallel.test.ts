import { describe, it, expect } from 'vitest';
import {
  boundedLeastSquares, lsqSteps, runSteps, runStepsSync, multiStartLeastSquares, multiStartSteps, BayesOpt, rateSteps,
  type ResidualFn,
} from '../src/core';
import { runLimited } from '../src/app/workerPool';

// Rosenbrock as residuals, with a bound active at the answer.
const rosen: ResidualFn = (x) => [10 * (x[1]! - x[0]! * x[0]!), 1 - x[0]!];
const lo = [-2, -1], hi = [0.8, 2];
/** A batch evaluator like the worker pool's: answers after a tick, in order. */
const asBatch = (f: ResidualFn) => async (xs: number[][]) => { await Promise.resolve(); return xs.map((x) => f(x)); };

describe('parallel evaluation: the same search in batches', () => {
  it('least squares: one at a time, in batches, and with parallel damping trials give the same answer', async () => {
    const seq = boundedLeastSquares(rosen, [-1.2, 1], lo, hi, { maxIterations: 200 });
    const batched = await runSteps(lsqSteps([-1.2, 1], lo, hi, { maxIterations: 200 }), asBatch(rosen));
    expect(batched.x).toEqual(seq.x);
    expect(batched.evaluations).toBe(seq.evaluations);
    expect(batched.iterations).toBe(seq.iterations);
    // Several damping trials per batch: same path (the first acceptable trial in order wins), more evaluations.
    const par = await runSteps(lsqSteps([-1.2, 1], lo, hi, { maxIterations: 200, parallel: 4 }), asBatch(rosen));
    expect(par.x).toEqual(seq.x);
    expect(par.iterations).toBe(seq.iterations);
    expect(par.evaluations).toBeGreaterThanOrEqual(seq.evaluations);
    expect(seq.x[0]).toBeCloseTo(0.8, 6);
    // Every Jacobian column is in one batch: n points (plus retries) per round.
    const sizes: number[] = [];
    const g = lsqSteps([-1.2, 1], lo, hi, { maxIterations: 3 });
    let s = g.next();
    while (!s.done) { sizes.push(s.value.length); s = g.next(s.value.map((x) => rosen(x))); }
    expect(sizes[0]).toBe(1);
    expect(sizes[1]).toBe(2);
  });

  it('multi-start: batched DOE and runs match the one-at-a-time search', async () => {
    const opts = { maxIterations: 100 }, ms = { starts: 3, seed: 5 };
    const seq = multiStartLeastSquares(rosen, [-1.2, 1], lo, hi, opts, ms);
    const par = await runSteps(multiStartSteps([-1.2, 1], lo, hi, opts, ms), asBatch(rosen));
    expect(par.x).toEqual(seq.x);
    expect(par.start).toBe(seq.start);
    expect(runStepsSync(multiStartSteps([-1.2, 1], lo, hi, opts, ms), rosen).cost).toBe(seq.cost);
  });

  it('Bayesian batches: distinct points that spread out; batched rate search finds the minimum', () => {
    const bo = new BayesOpt(2, { seed: 3 });
    const f = (u: number[]) => (u[0]! - 0.3) ** 2 + (u[1]! - 0.7) ** 2;
    for (const u of bo.suggestBatch(12)) bo.observe(u, f(u)); // the Latin hypercube first
    const b = bo.suggestBatch(4);
    expect(b).toHaveLength(4);
    expect(bo.xs).toHaveLength(12); // the "lies" are taken back out
    for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) expect(Math.hypot(b[i]![0]! - b[j]![0]!, b[i]![1]! - b[j]![1]!)).toBeGreaterThan(1e-3);
    // Rate search: two "rates" with a minimum at 30 / 3000, scored 4 at a time.
    const vars = [{ kind: 'spring' as const, lo: 10, hi: 100, value: 50, label: 'k' }, { kind: 'bump' as const, lo: 1000, hi: 10000, value: 5000, label: 'c' }];
    const score = (x: number[]) => [Math.log(x[0]! / 30) ** 2 + Math.log(x[1]! / 3000) ** 2];
    const r = runStepsSync(rateSteps(vars, { budget: 40, batch: 4 }), score);
    expect(r.evaluations).toBe(40);
    expect(r.after).toBeLessThan(r.before);
    expect(r.after).toBeLessThan(0.05);
  });

  it('several jobs at once: never more than the limit, results in order, stoppable', async () => {
    let running = 0, peak = 0;
    const out = await runLimited([5, 1, 4, 2, 3, 6], 3, async (v) => {
      running++; peak = Math.max(peak, running);
      await new Promise((res) => setTimeout(res, v * 3));
      running--;
      return v * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 60]);
    expect(peak).toBe(3);
    let n = 0;
    const part = await runLimited([1, 2, 3, 4, 5], 1, async (v) => { n++; return v; }, () => n >= 2);
    expect(part.filter((x) => x !== undefined)).toEqual([1, 2]);
  });
});
