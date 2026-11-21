import { describe, it, expect } from 'vitest';
import {
  DoubleWishbone, springLength, springForce, wheelLoadAt, solveEquilibrium, fitFreeLength, rideMetrics,
  tireRate, illinois, distance, type SpringSpec, type TireForceModel,
} from '../src/core';
import { SAMPLE_LAYOUTS } from '../src/examples/sampleLayouts';

const geom = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
const corner = new DoubleWishbone(geom);
const spec: SpringSpec = { rate: 60, freeLength: 406 };

describe('illinois root finder', () => {
  it('finds a bracketed root', () => {
    expect(illinois((x) => x * x * x - 2, 0, 2)).toBeCloseTo(Math.cbrt(2), 6);
  });
  it('rejects an unbracketed interval', () => {
    expect(() => illinois((x) => x * x + 1, -1, 1)).toThrow();
  });
});

describe('spring geometry', () => {
  it('design length is the mount-to-mount distance', () => {
    expect(springLength(corner.design())!).toBeCloseTo(distance(geom.damper!.chassis, geom.damper!.armPoint), 9);
  });
  it('spring compresses in bump (positive motion ratio)', () => {
    const w = wheelLoadAt(corner, spec, 0);
    expect(w.motionRatio).toBeGreaterThan(0.5);
    expect(w.motionRatio).toBeLessThan(1);
    expect(springLength(corner.solve({ travel: 20 }))!).toBeLessThan(springLength(corner.design())!);
  });
  it('energy check: ∫ wheel force d(contact height) equals the spring energy change', () => {
    // Independent of how the motion ratio is computed: virtual work must match ½k·Δ(compression²).
    const travels = Array.from({ length: 161 }, (_, i) => -20 + i * 0.25);
    const states = corner.sweep(travels, (travel) => ({ travel }));
    let work = 0;
    for (let i = 1; i < states.length; i++) {
      const a = states[i - 1]!;
      const b = states[i]!;
      const la = springLength(a)!;
      const lb = springLength(b)!;
      // Wheel force × wheel displacement over the step = spring force × spring compression.
      const fMid = springForce(spec, (la + lb) / 2);
      work += fMid * (la - lb);
    }
    const c0 = spec.freeLength - springLength(states[0]!)!;
    const c1 = spec.freeLength - springLength(states[states.length - 1]!)!;
    const energy = 0.5 * spec.rate * (c1 * c1 - c0 * c0);
    expect(work).toBeCloseTo(energy, 0);
    // And the same work via wheel force × contact travel (the motion-ratio path):
    let work2 = 0;
    for (let t = -20; t < 20 - 1e-9; t += 1) {
      const m = wheelLoadAt(corner, spec, t + 0.5);
      const ya = corner.solve({ travel: t }).points.contact.y;
      const yb = corner.solve({ travel: t + 1 }).points.contact.y;
      work2 += m.wheelForce * (yb - ya);
    }
    expect(Math.abs(work2 - energy) / energy).toBeLessThan(2e-3);
  });
});

describe('equilibrium', () => {
  it('finds the travel where the spring carries the sprung load', () => {
    const eq = solveEquilibrium(corner, spec, 780, [-50, 50]);
    expect(eq.status).toBe('ok');
    expect(eq.load.wheelForce).toBeCloseTo(780, 1);
  });
  it('fitted free length puts equilibrium at the design position', () => {
    const fl = fitFreeLength(corner, 60, 780);
    const eq = solveEquilibrium(corner, { rate: 60, freeLength: fl }, 780, [-50, 50]);
    expect(eq.travel).toBeCloseTo(0, 2);
  });
  it('more load → more bump travel; reports limits', () => {
    const a = solveEquilibrium(corner, spec, 600, [-50, 50]).travel;
    const b = solveEquilibrium(corner, spec, 900, [-50, 50]).travel;
    expect(b).toBeGreaterThan(a);
    expect(solveEquilibrium(corner, spec, 0, [-50, 50]).status).toBe('droop-limit');
    expect(solveEquilibrium(corner, spec, 1e6, [-50, 50]).status).toBe('bump-limit');
  });
  it('wheel rate is close to k·MR²', () => {
    const eq = solveEquilibrium(corner, spec, 780, [-50, 50]);
    const approx = spec.rate * eq.load.motionRatio ** 2;
    expect(Math.abs(eq.wheelRate - approx) / approx).toBeLessThan(0.2);
  });
});

describe('ride metrics', () => {
  it('series springs and natural frequency', () => {
    const r = rideMetrics(30, 200, 80);
    expect(r.rideRate).toBeCloseTo(1 / (1 / 30 + 1 / 200), 9);
    expect(r.frequency).toBeCloseTo(Math.sqrt(r.rideRate * 1000 / 80) / (2 * Math.PI), 9);
    expect(rideMetrics(30, Infinity, 80).rideRate).toBe(30);
  });
  it('tire rate from the stiffness model equals the stiffness', () => {
    const m: TireForceModel = { kind: 'stiffness', rate: 120 };
    const profile = { radius: 260, width: 205, shoulderRadius: 25, rimRadius: 165 };
    expect(tireRate(m, profile, 0, 900)).toBeCloseTo(120, 2);
  });
});
