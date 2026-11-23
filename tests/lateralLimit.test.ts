import { describe, it, expect } from 'vitest';
import {
  evaluateVehicle, vehicleGoalValue, assembleVehicle, solveCase, lateralLimit, caseList, optimizeVehicle,
  type TireForceModel, type VehicleProblem, type VehicleVariable,
} from '../src/core';
import { SAMPLE_LAYOUTS, SAMPLE_SPRING } from '../src/examples/sampleLayouts';

const profile = { radius: 260, width: 205, shoulderRadius: 25, rimRadius: 165 };
const gas: TireForceModel = { kind: 'gas', volumeChange: true, volumeFactor: 1, conditions: { setPressure: 83, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 } };
const geom = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
const des = { geometry: geom, profile, model: gas, springRate: SAMPLE_SPRING.rate, freeLength: SAMPLE_SPRING.freeLength, unsprungMass: 12 };
const NONE = { antiRollBar: { kind: 'none' as const }, heaveSpring: { kind: 'none' as const } };
const base: VehicleProblem = {
  designs: { FL: des, RL: des },
  roots: { FL: 'FL', FR: 'FL', RL: 'RL', RR: 'RL' },
  settings: { FL: { brake: 'outboard', drive: 'none' }, FR: { brake: 'outboard', drive: 'none' }, RL: { brake: 'outboard', drive: 'chassis' }, RR: { brake: 'outboard', drive: 'chassis' } },
  mass: 300, cg: { x: 0, height: 280, z: -0.47 * 1550 }, wheelbase: 1550, brakeBias: 0.6, driveSplit: 0.5, autoPreload: true,
  shared: { front: NONE, rear: NONE },
  dropLinks: { front: null, rear: null }, droop: 50, bump: 50,
  cases: { lateralG: 1, brakingG: 1, accelG: 0 },
  goals: [{ kind: 'lateralLimit', target: 0, weight: 1 }], variables: [],
};

describe('cornering limit (axle saturation)', () => {
  it('finds the lateral g where the first axle reaches its grip', () => {
    const asm = assembleVehicle(base, { FL: geom, RL: geom })!;
    const lim = lateralLimit(base, asm)!;
    expect(lim).not.toBeNull();
    expect(lim.g).toBeGreaterThan(0.6);
    expect(lim.g).toBeLessThan(3);
    const at = solveCase(base, asm, { name: 'x', kind: 'lateral', g: lim.g, lateralG: lim.g, brakingG: 0, accelG: 0 })!;
    const a = at.result.grip!.axles;
    expect(Math.max(a.front, a.rear)).toBeCloseTo(1, 2);
    expect(lim.other).toBeLessThanOrEqual(1 + 1e-6);
    // A warm start near the answer needs few solves.
    expect(lateralLimit(base, asm, { g: lim.g + 0.01, pose: lim.pose })!.solves).toBeLessThanOrEqual(4);
    // The goal reports it.
    const e = evaluateVehicle(base, { FL: geom, RL: geom })!;
    expect(vehicleGoalValue('lateralLimit', base, e)).toBeCloseTo(lim.g, 2);
  });

  it('a stiff front bar moves load transfer forward: the front saturates first, at a lower g', () => {
    const free = lateralLimit(base, assembleVehicle(base, { FL: geom, RL: geom })!)!;
    const p = { ...base, shared: { front: { ...NONE, antiRollBar: { kind: 'wheelRate' as const, rate: 60 } }, rear: NONE } };
    const barred = lateralLimit(p, assembleVehicle(p, { FL: geom, RL: geom })!)!;
    expect(barred.axle).toBe('front');
    expect(barred.g).toBeLessThan(free.g);
    const pr = { ...base, shared: { front: NONE, rear: { ...NONE, antiRollBar: { kind: 'wheelRate' as const, rate: 60 } } } };
    expect(lateralLimit(pr, assembleVehicle(pr, { FL: geom, RL: geom })!)!.axle).toBe('rear');
  });

  it('is only computed when a goal needs it', () => {
    const e = evaluateVehicle({ ...base, goals: [] }, { FL: geom, RL: geom })!;
    expect(e.limit).toBeUndefined();
  });
});

describe('combined load cases', () => {
  it('adds braking in a turn with both accelerations, and weights the averaged goals', () => {
    const p: VehicleProblem = { ...base, goals: [], cases: { lateralG: 1, brakingG: 1, accelG: 0, combined: { lateralG: 0.7, brakingG: 0.7 } } };
    const list = caseList(p);
    expect(list.map((c) => c.name)).toEqual(['lateral', 'braking', 'combined']);
    const cb = list[2]!;
    expect(cb.lateralG).toBe(0.7);
    expect(cb.brakingG).toBe(0.7);
    expect(cb.g).toBeCloseTo(Math.hypot(0.7, 0.7), 9);
    // Off when either half is 0.
    expect(caseList({ ...p, cases: { ...p.cases, combined: { lateralG: 0.7, brakingG: 0 } } }).length).toBe(2);

    const e = evaluateVehicle(p, { FL: geom, RL: geom })!;
    const c = e.cases.find((x) => x.name === 'combined')!;
    // Braking in a turn: nose down and rolled; the outside front carries the most load.
    expect(c.result.pose.pitch).toBeGreaterThan(0);
    expect(Math.abs(c.result.pose.roll)).toBeGreaterThan(0);
    const loads = (['FL', 'FR', 'RL', 'RR'] as const).map((id) => c.result.corners[id].tireLoad);
    expect(Math.max(...loads)).toBe(c.result.corners.FR.tireLoad);

    // Weights: only the combined case counts → the grip goal equals that case alone.
    const only = { ...p, cases: { ...p.cases, weights: { lateral: 0, braking: 0, combined: 1 } } };
    const eo = evaluateVehicle(only, { FL: geom, RL: geom })!;
    const one = evaluateVehicle({ ...p, cases: { lateralG: 0, brakingG: 0, accelG: 0, combined: { lateralG: 0.7, brakingG: 0.7 } } }, { FL: geom, RL: geom })!;
    expect(vehicleGoalValue('grip', only, eo)!).toBeCloseTo(vehicleGoalValue('grip', p, one)!, 6);
  });
});

describe('maximizing the cornering limit', () => {
  it('sets the front static camber for the most cornering grip on a front-limited car', () => {
    // Stiff front bar: the front saturates first; leaning the front wheels into the turn helps it.
    const vars: VehicleVariable[] = [{ root: 'FL', point: 'staticCamber', axis: 0, lo: -3, hi: 0 }];
    const p: VehicleProblem = {
      ...base, cases: { lateralG: 0, brakingG: 0, accelG: 0 }, tableSamples: 9,
      shared: { front: { ...NONE, antiRollBar: { kind: 'wheelRate' as const, rate: 40 } }, rear: NONE }, variables: vars, maxIterations: 3,
    };
    const r = optimizeVehicle(p);
    expect(r.variables[0]!.after).toBeLessThan(-0.5);
    expect(r.goals[0]!.after!).toBeGreaterThan(r.goals[0]!.before! + 0.005);
  }, 180_000);
});
