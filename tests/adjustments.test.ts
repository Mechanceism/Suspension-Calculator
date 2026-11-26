import { describe, expect, it } from 'vitest';
import { problemAt, vehicleVariableValue, designRideHeight, optimizeVehicle, type VehicleProblem } from '../src/core/optimize/vehicle';
import { useApp, defaultDesign, mergedCorners, type AppState } from '../src/app/store';
import { buildVehicleProblem, vehScalarKey, parseVehScalarKey, vehUpdateOf } from '../src/app/optimizer';
import { adjustmentRanges } from '../src/app/testOptimize';

// Round 5: the vehicle (and Tests) optimizer's other variables — static camber, toe, tire pressure, ride height.
const problemWith = (ranges: Record<string, { lo: number; hi: number }>, goals: Partial<Record<string, { on: boolean; target?: number; weight?: number }>> = {}) => {
  const d = defaultDesign();
  const f = (x: number) => ({ text: String(x), value: x });
  const s = {
    ...d,
    vehicleOptimizer: {
      ...d.vehicleOptimizer,
      ranges: Object.fromEntries(Object.entries(ranges).map(([k, r]) => [k, { lo: f(r.lo), hi: f(r.hi) }])),
      goals: Object.fromEntries(Object.entries(d.vehicleOptimizer.goals).map(([k, g]) => [k, goals[k] ? { ...g, on: goals[k]!.on, ...(goals[k]!.target !== undefined ? { target: f(goals[k]!.target!) } : {}), ...(goals[k]!.weight !== undefined ? { weight: f(goals[k]!.weight!) } : {}) } : { ...g, on: false }])),
    },
  };
  return buildVehicleProblem(s as unknown as AppState).problem;
};

describe('the optimizer\'s other variables', () => {
  it('keys, values, and the problem at x (pressure and ride height set)', () => {
    expect(parseVehScalarKey(vehScalarKey('FL', 'tirePressure'))).toEqual({ root: 'FL', name: 'tirePressure' });
    expect(parseVehScalarKey('FL.trInner.y')).toBeNull();
    const p = problemWith({ 'FL.scalar.tirePressure': { lo: 60, hi: 110 }, 'FL.scalar.rideHeight': { lo: 50, hi: 120 }, 'RL.scalar.rideHeight': { lo: 50, hi: 120 }, 'FL.scalar.staticCamber': { lo: -3, hi: 1 } });
    expect(p.variables.map((v) => v.point).sort()).toEqual(['rideHeight', 'rideHeight', 'staticCamber', 'tirePressure']);
    const design = designRideHeight(p);
    expect(design).toBeGreaterThan(20);
    const x0 = p.variables.map((v) => vehicleVariableValue(p, v, design));
    const iP = p.variables.findIndex((v) => v.point === 'tirePressure'), iF = p.variables.findIndex((v) => v.point === 'rideHeight' && v.root === 'FL');
    const m = p.designs.FL!.model as Extract<VehicleProblem['designs']['FL'], object>['model'] & { kind: 'gas' };
    expect(x0[iP]).toBeCloseTo(m.conditions.setPressure, 9);
    expect(x0[iF]).toBeCloseTo(design, 9);
    const x = [...x0]; x[iP] = 100; x[iF] = design - 10;
    const q = problemAt(p, x);
    expect((q.designs.FL!.model as typeof m).conditions.setPressure).toBe(100);
    expect(q.rideHeight?.front).toBeCloseTo(design - 10, 9);
    expect(p.rideHeight?.front).toBeUndefined(); // the problem itself unchanged
  });

  it('static camber as a variable: the optimizer moves it toward a goal the points alone would have to reach', () => {
    // Only the front design's static camber free; the outside-tire inclination goal (cornering) wants −2°.
    const p = problemWith({ 'FL.scalar.staticCamber': { lo: -4, hi: 2 } }, { inclination: { on: true, target: -2, weight: 1 } });
    expect(p.variables.length).toBe(1);
    const r = optimizeVehicle({ ...p, maxIterations: 15 });
    const v = r.variables[0]!;
    expect(v.point).toBe('staticCamber');
    expect(v.after).toBeLessThan(v.before - 0.2); // more negative camber
    expect(Math.abs(v.after - v.before)).toBeGreaterThan(0.2);
  }, 120000);

  it('applied to the designs and undone in one step (camber, pressure, ride height)', () => {
    const d = defaultDesign();
    useApp.getState().applyDesign(d as never, null, null);
    const s0 = useApp.getState();
    const camber0 = mergedCorners(s0).FL.geom.scalars.staticCamber.value, p0 = mergedCorners(s0).FL.tire.pressure.value;
    s0.applyVehicleOptimized([
      vehUpdateOf({ root: 'FL', point: 'staticCamber', axis: 0 }, -1.25),
      vehUpdateOf({ root: 'FL', point: 'tirePressure', axis: 0 }, 95),
      vehUpdateOf({ root: 'RL', point: 'rideHeight', axis: 0 }, 77),
    ]);
    const s1 = useApp.getState();
    expect(mergedCorners(s1).FL.geom.scalars.staticCamber.value).toBeCloseTo(-1.25, 6);
    expect(mergedCorners(s1).FL.tire.pressure.value).toBeCloseTo(95, 6);
    expect(s1.rideHeight.on).toBe(true);
    expect(s1.rideHeight.rear.value).toBeCloseTo(77, 6);
    s1.undoVehicleOptimized();
    const s2 = useApp.getState();
    expect(mergedCorners(s2).FL.geom.scalars.staticCamber.value).toBeCloseTo(camber0, 9);
    expect(mergedCorners(s2).FL.tire.pressure.value).toBeCloseTo(p0, 9);
    expect(s2.rideHeight.on).toBe(d.rideHeight.on);
  });

  it('freeing them: default ranges, locked ones left out', () => {
    const d = defaultDesign();
    const r = adjustmentRanges(d as unknown as AppState);
    expect(Object.keys(r).sort()).toEqual(['FL.scalar.rideHeight', 'FL.scalar.staticCamber', 'FL.scalar.staticToe', 'FL.scalar.tirePressure', 'RL.scalar.rideHeight'].sort());
    expect(r['FL.scalar.staticCamber']!.hi.value - r['FL.scalar.staticCamber']!.lo.value).toBeCloseTo(3, 9);
    const locked = adjustmentRanges({ ...d, locks: { 'FL.tire.pressure': true } } as unknown as AppState);
    expect(locked['FL.scalar.tirePressure']).toBeUndefined();
  });
});
