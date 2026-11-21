import { describe, it, expect } from 'vitest';
import {
  boundedLeastSquares, optimizeCorner, sampleCorner, goalValue, withVariables, armMetrics,
  DoubleWishbone, CornerTable, solveVehicle, staticCornerLoads, fitFreeLength, designGroundY, CORNER_IDS,
  characteristics, deg, vec3,
  type Variable, type TireForceModel,
} from '../src/core';
import { SAMPLE_LAYOUTS, SAMPLE_SPRING } from '../src/examples/sampleLayouts';

const geom = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
const RANGE = { droop: -50, bump: 50 };

const around = (point: Variable['point'], axis: 0 | 1 | 2, half: number): Variable => {
  const p = { trInner: geom.tieRod.inner, trOuter: geom.tieRod.outer, ucaFwd: geom.uca.fwd, ucaAft: geom.uca.aft, lcaOut: geom.lca.out }[point as 'trInner']!;
  const v = [p.x, p.y, p.z][axis]!;
  return { point, axis, lo: v - half, hi: v + half };
};

describe('bounded least squares', () => {
  it('solves Rosenbrock, and stops on a bound when the optimum lies outside', () => {
    const rosen = (x: number[]) => [10 * (x[1]! - x[0]! * x[0]!), 1 - x[0]!];
    const free = boundedLeastSquares(rosen, [-1.2, 1], [-5, -5], [5, 5], { step: 1e-6, maxIterations: 200 });
    expect(free.x[0]).toBeCloseTo(1, 4);
    expect(free.x[1]).toBeCloseTo(1, 4);
    const boxed = boundedLeastSquares(rosen, [-1.2, 0.2], [-5, -5], [0.5, 5], { step: 1e-6, maxIterations: 200 });
    expect(boxed.x[0]).toBeCloseTo(0.5, 6);
    expect(boxed.atBound[0]).toBe(1);
    expect(boxed.x[1]).toBeCloseTo(0.25, 4);
  });

  it('treats an infeasible point as worse and keeps going', () => {
    const f = (x: number[]) => (x[0]! > 2 ? null : [x[0]! - 3]);
    const r = boundedLeastSquares(f, [0], [-10], [10], { step: 1e-6 });
    expect(r.x[0]).toBeLessThanOrEqual(2);
    expect(r.x[0]).toBeGreaterThan(1.9);
  });
});

describe('corner optimizer', () => {
  it('moves the tie-rod mounts to remove bump steer, within the ranges, and nothing else', () => {
    const vars: Variable[] = [
      around('trInner', 0, 30), around('trInner', 1, 30), around('trInner', 2, 30),
      around('trOuter', 0, 30), around('trOuter', 1, 30), around('trOuter', 2, 30),
    ];
    // Start from a version of layout C with clear bump steer (inner tie-rod 25 mm high).
    const start = withVariables(geom, [vars[1]!], [geom.tieRod.inner.y + 25]);
    const before = goalValue('bumpSteer', sampleCorner(start, RANGE)!)!;
    expect(before).toBeGreaterThan(0.3);
    const r = optimizeCorner({ geometry: start, ...RANGE, goals: [{ kind: 'bumpSteer', target: 0, weight: 1 }], variables: vars });
    const after = r.goals[0]!.after!;
    expect(after).toBeLessThan(0.01);
    for (const v of r.variables) {
      expect(v.after).toBeGreaterThanOrEqual(Math.min(v.lo, v.hi) - 1e-9);
      expect(v.after).toBeLessThanOrEqual(Math.max(v.lo, v.hi) + 1e-9);
    }
    expect(r.geometry.uca).toEqual(start.uca);
    expect(r.geometry.lca).toEqual(start.lca);
    expect(r.geometry.wheel.center).toEqual(start.wheel.center);
    // Static toe is unchanged (the design spin axis holds it).
    expect(deg(characteristics(new DoubleWishbone(r.geometry).design()).toe)).toBeCloseTo(deg(characteristics(new DoubleWishbone(start).design()).toe), 6);
  });

  it('a too-tight range leaves the variable on its limit and flags it', () => {
    const start = withVariables(geom, [around('trInner', 1, 0)], [geom.tieRod.inner.y + 25]);
    const v: Variable = { point: 'trInner', axis: 1, lo: start.tieRod.inner.y - 5, hi: start.tieRod.inner.y + 5 };
    const r = optimizeCorner({ geometry: start, ...RANGE, goals: [{ kind: 'bumpSteer', target: 0, weight: 1 }], variables: [v] });
    expect(r.variables[0]!.atLimit).toBe(true);
    expect(r.variables[0]!.after).toBeCloseTo(start.tieRod.inner.y - 5, 6);
  });

  it('hits a camber-gain target while a locked arm length is held', () => {
    const vars = [around('ucaFwd', 0, 40), around('ucaAft', 0, 40), around('ucaFwd', 1, 40), around('ucaAft', 1, 40)];
    const target = -2.5;
    const r = optimizeCorner({
      geometry: geom, ...RANGE, goals: [{ kind: 'camberGain', target, weight: 1 }], variables: vars,
      holds: [{ arm: 'uca', which: 'length' }],
    });
    expect(r.goals[0]!.after!).toBeCloseTo(target, 1);
    expect(Math.abs(armMetrics(r.geometry.uca).length - armMetrics(geom.uca).length)).toBeLessThan(0.01);
  });

  it('hits static targets (roll center height, KPI)', () => {
    const vars = [around('ucaFwd', 1, 40), around('ucaAft', 1, 40), around('lcaOut', 0, 15), around('lcaOut', 1, 15)];
    const r = optimizeCorner({
      geometry: geom, ...RANGE, variables: vars,
      goals: [{ kind: 'rollCenter', target: 80, weight: 1 }, { kind: 'kpi', target: 7, weight: 1 }],
    });
    expect(r.goals[0]!.after!).toBeCloseTo(80, 0);
    expect(r.goals[1]!.after!).toBeCloseTo(7, 1);
  });
});

describe('roll-camber goal sign', () => {
  it('outside-wheel inclination = camber at its travel + body roll, as in the whole-car solve', () => {
    const corner = new DoubleWishbone(geom);
    const profile = { radius: 260, width: 205, shoulderRadius: 25, rimRadius: 165 };
    const gas: TireForceModel = { kind: 'gas', volumeChange: true, volumeFactor: 1, conditions: { setPressure: 83, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 } };
    const cg = vec3(0, 280, -0.47 * 1550);
    const cx = corner.design().points.contact.x;
    const loads = staticCornerLoads(300, cg, 1550, { FL: cx, FR: cx, RL: cx, RR: cx });
    const table = new CornerTable(corner, 0, [-50, 50]);
    const groundY = designGroundY(CORNER_IDS.map((id) => ({ contactY: corner.design().points.contact.y, profile, model: gas, staticLoad: loads[id], tilt: 0 })));
    const r = solveVehicle({
      totalMass: 300, cg, wheelbase: 1550, groundY, lateralG: 1,
      corners: CORNER_IDS.map((id) => ({ id, table, unsprungMass: 12, tire: { profile, model: gas }, spring: { rate: SAMPLE_SPRING.rate, freeLength: fitFreeLength(corner, SAMPLE_SPRING.rate, loads[id] - 12 * 9.80665) } })),
    });
    const outside = CORNER_IDS.reduce((a, b) => (r.corners[a].tireLoad > r.corners[b].tireLoad ? a : b));
    const c = r.corners[outside];
    const camber = characteristics(corner.solve({ travel: c.travel })).camber;
    expect(c.travel).toBeGreaterThan(0);
    expect(deg(c.inclination)).toBeCloseTo(deg(camber + Math.abs(r.pose.roll)), 1);
  });
});
