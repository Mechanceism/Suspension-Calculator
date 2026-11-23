import { describe, it, expect } from 'vitest';
import { fitTire, writeTir, parseTir, tirForces, tirMz0, type TirModel, type TireSample } from '../src/core';

// A "true" tire with combined-slip and aligning-moment coefficients (ISO signs, SI).
const truth: TirModel = {
  kind: 'tir', name: 'truth', fittyp: 61, version: '6.1', fnomin: 1200, nompres: 0,
  p: {
    PCY1: 1.45, PDY1: 1.6, PDY2: -0.15, PEY1: -0.8, PKY1: -25, PKY2: 1.6, PKY4: 2, PCX1: 1.6, PDX1: 1.7, PDX2: -0.12, PKX1: 28, PEX1: 0.1,
    RBX1: 14, RBX2: 10, RCX1: 1.1, RBY1: 10, RBY2: 8, RCY1: 1.05,
    UNLOADED_RADIUS: 0.26, QBZ1: 9, QCZ1: 1.25, QDZ1: 0.09, QDZ2: -0.01, QEZ1: -2, QHZ1: 0.002, QDZ6: 0.003, QBZ10: 0.4,
  },
};

function samples(): TireSample[] {
  const out: TireSample[] = [];
  for (const fz of [700, 1000, 1300]) {
    for (let a = -10; a <= 10; a += 0.5) {
      const alpha = (a * Math.PI) / 180;
      const f0 = tirForces(truth, { fz, kappa: 0, alpha, gamma: 0 });
      out.push({ sa: alpha, sl: 0, fz, ia: 0, fx: 0, fy: f0.fy, mz: tirMz0(truth, { fz, kappa: 0, alpha, gamma: 0 }).mz });
      for (const k of [-0.12, -0.06, 0.06, 0.12]) {
        if (Math.abs(a) < 2) continue;
        const f = tirForces(truth, { fz, kappa: k, alpha, gamma: 0 });
        out.push({ sa: alpha, sl: k, fz, ia: 0, fx: f.fx, fy: f.fy });
      }
    }
    for (let k = -0.2; k <= 0.2; k += 0.01) out.push({ sa: 0, sl: k, fz, ia: 0, fx: tirForces(truth, { fz, kappa: k, alpha: 0, gamma: 0 }).fx, fy: 0 });
  }
  return out;
}

describe('fitting combined slip and the aligning moment', () => {
  it('the aligning moment has a pneumatic trail that falls off with slip angle', () => {
    const t1 = tirMz0(truth, { fz: 1200, kappa: 0, alpha: 0.01, gamma: 0 }).trail, t2 = tirMz0(truth, { fz: 1200, kappa: 0, alpha: 0.15, gamma: 0 }).trail;
    expect(t1).toBeGreaterThan(0.01);
    expect(t2).toBeLessThan(t1);
  });
  it('recovers the combined-slip forces and Mz, and writes them to the .tir', () => {
    const r = fitTire(samples(), { name: 'fit.tir', unloadedRadius: 0.26 });
    expect(r.combinedLongitudinal!.r2).toBeGreaterThan(0.99);
    expect(r.combinedLateral!.r2).toBeGreaterThan(0.99);
    expect(r.moment!.r2).toBeGreaterThan(0.98);
    for (const [k, a] of [[0.08, 0.1], [-0.05, -0.06]] as const) {
      const t = tirForces(truth, { fz: 1000, kappa: k, alpha: a, gamma: 0 }), f = tirForces(r.model, { fz: 1000, kappa: k, alpha: a, gamma: 0 });
      expect(Math.abs(f.fx - t.fx)).toBeLessThan(0.03 * 1700);
      expect(Math.abs(f.fy - t.fy)).toBeLessThan(0.03 * 1600);
    }
    const back = parseTir(writeTir(r.model), 'back.tir').model!;
    expect(back.p.QBZ1).toBeCloseTo(r.model.p.QBZ1!, 4);
    expect(back.p.RBY1).toBeCloseTo(r.model.p.RBY1!, 4);
    expect(tirMz0(back, { fz: 1000, kappa: 0, alpha: 0.05, gamma: 0 }).mz).toBeCloseTo(tirMz0(r.model, { fz: 1000, kappa: 0, alpha: 0.05, gamma: 0 }).mz, 3);
  });
});
