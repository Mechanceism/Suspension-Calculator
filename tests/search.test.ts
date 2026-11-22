import { describe, it, expect } from 'vitest';
import { rng, latinHypercube, multiStartLeastSquares, sensitivity, BayesOpt, boundedLeastSquares } from '../src/core';

describe('search strategies', () => {
  it('Latin hypercube: one sample per stratum of every variable', () => {
    const s = latinHypercube(10, 3, rng(1));
    for (let j = 0; j < 3; j++) {
      const strata = s.map((x) => Math.floor(x[j]! * 10)).sort((a, b) => a - b);
      expect(strata).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    }
  });

  it('multi-start finds the deeper valley a single gradient run misses', () => {
    // Two valleys: a shallow one near x = 0.96 (where it starts) and a deeper one near x = −1.04.
    const f = (x: number[]) => { const v = x[0]!; return [Math.sqrt((v * v - 1) ** 2 + 0.3 * v + 0.5)]; };
    const single = boundedLeastSquares(f, [0.9], [-2], [2], { step: 1e-4 });
    const multi = multiStartLeastSquares(f, [0.9], [-2], [2], { step: 1e-4 }, { starts: 4 });
    expect(single.x[0]!).toBeGreaterThan(0.5);
    expect(multi.x[0]!).toBeCloseTo(-1.04, 1);
    expect(multi.cost).toBeLessThan(single.cost);
  });

  it('sensitivity recovers the effects and the strongest interaction', () => {
    const us = latinHypercube(60, 4, rng(3));
    // y = 3·a − 1·c + 2·a·b (coded −1..1); d does nothing.
    const ys = us.map((u) => { const c = u.map((v) => 2 * v - 1); return 3 * c[0]! - c[2]! + 2 * c[0]! * c[1]!; });
    const s = sensitivity(us, ys)!;
    expect(s.effects[0]!.index).toBe(0);
    expect(s.effects[0]!.effect).toBeCloseTo(6, 1);
    const ec = s.effects.find((e) => e.index === 2)!;
    expect(ec.effect).toBeCloseTo(-2, 1);
    expect(Math.abs(s.effects.find((e) => e.index === 3)!.effect)).toBeLessThan(0.3);
    expect(s.interactions[0]).toMatchObject({ a: 0, b: 1 });
    expect(s.interactions[0]!.effect).toBeCloseTo(4, 1);
    expect(s.r2).toBeGreaterThan(0.99);
  });

  it('Bayesian optimization finds a 2-D minimum in ~30 tests, better than as many random tries', () => {
    const f = (x: number[]) => (x[0]! - 0.7) ** 2 + 2 * (x[1]! - 0.25) ** 2 + 0.3 * Math.sin(8 * x[0]!) ** 2;
    const bo = new BayesOpt(2, { seed: 5 });
    for (let i = 0; i < 30; i++) { const x = bo.suggest(); bo.observe(x, f(x)); }
    const r = rng(99);
    let bestRandom = Infinity;
    for (let i = 0; i < 30; i++) bestRandom = Math.min(bestRandom, f([r(), r()]));
    const best = bo.best()!;
    expect(best.y).toBeLessThan(bestRandom);
    expect(best.y).toBeLessThan(0.02);
  });
});
