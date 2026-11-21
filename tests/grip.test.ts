import { describe, it, expect } from 'vitest';
import {
  patchGrip, DEFAULT_GRIP, solveLoadedHeight, vec3, Y_AXIS, optimizeCorner, sampleCorner, goalValue,
  optimizeVehicle, evaluateVehicle, vehicleGoalValue,
  type TireForceModel, type Variable, type VehicleProblem, type VehicleVariable,
} from '../src/core';
import { SAMPLE_LAYOUTS, SAMPLE_SPRING } from '../src/examples/sampleLayouts';

const profile = { radius: 260, width: 205, shoulderRadius: 25, rimRadius: 165 };
const gas: TireForceModel = { kind: 'gas', volumeChange: true, volumeFactor: 1, conditions: { setPressure: 83, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 } };
const stiff: TireForceModel = { kind: 'stiffness', rate: 200 };
const geom = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;

const gripAt = (model: TireForceModel, inclDeg: number, load: number, m = DEFAULT_GRIP) => {
  const g = (inclDeg * Math.PI) / 180;
  const axis = vec3(Math.cos(g), -Math.sin(g), 0);
  const h = solveLoadedHeight(model, profile, axis.y, load).centerHeight;
  return patchGrip(vec3(0, h, 0), axis, { point: vec3(0, 0, 0), normal: Y_AXIS }, profile, load, m);
};

describe('patch grip model', () => {
  it('even pressure and no load sensitivity give exactly μ_ref · load', () => {
    const r = gripAt(gas, 2, 900, { muRef: 1.1, pRef: 100, sensitivity: 0, carcassShare: 0 });
    expect(r.capacity).toBeCloseTo(1.1 * 900, 6);
  });

  it('peaks with the wheel level to the ground and falls off symmetrically with inclination', () => {
    for (const model of [gas, stiff]) {
      const mu0 = gripAt(model, 0, 900).mu;
      expect(gripAt(model, 2, 900).mu).toBeLessThan(mu0);
      expect(gripAt(model, -2, 900).mu).toBeCloseTo(gripAt(model, 2, 900).mu, 6);
    }
    // The stiffness tire loses much more area with inclination than the air-spring tire.
    const dropStiff = 1 - gripAt(stiff, 2, 900).area / gripAt(stiff, 0, 900).area;
    const dropGas = 1 - gripAt(gas, 2, 900).area / gripAt(gas, 0, 900).area;
    expect(dropStiff).toBeGreaterThan(0.3);
    expect(dropGas).toBeLessThan(0.01);
  });

  it('load sensitivity: more load per tire gives a lower effective μ', () => {
    expect(gripAt(stiff, 0, 1500).mu).toBeLessThan(gripAt(stiff, 0, 600).mu);
  });
});

describe('grip goals', () => {
  it('corner: maximizing grip brings the loaded outside wheel closer to level in roll', () => {
    const tire = { profile, model: stiff, staticLoad: 780, rollLoadFactor: 1.5 };
    const vars: Variable[] = (['ucaFwd', 'ucaAft'] as const).flatMap((k) => ([0, 1] as const).map((a) => {
      const p = geom.uca[k === 'ucaFwd' ? 'fwd' : 'aft'];
      const v = [p.x, p.y][a]!;
      return { point: k, axis: a, lo: v - 40, hi: v + 40 };
    }));
    const base = { droop: -50, bump: 50, rollAngle: 2, tire };
    const before = sampleCorner(geom, base)!;
    const r = optimizeCorner({ geometry: geom, ...base, variables: vars, goals: [{ kind: 'grip', target: 0, weight: 1 }] });
    const after = sampleCorner(r.geometry, base)!;
    expect(goalValue('grip', after)!).toBeGreaterThan(goalValue('grip', before)!);
    expect(Math.abs(goalValue('rollCamber', after)!)).toBeLessThan(Math.abs(goalValue('rollCamber', before)!));
  });
});

describe('vehicle optimizer', () => {
  const des = { geometry: geom, profile, model: gas, springRate: SAMPLE_SPRING.rate, freeLength: SAMPLE_SPRING.freeLength, unsprungMass: 12 };
  const base: VehicleProblem = {
    designs: { FL: des, RL: des },
    roots: { FL: 'FL', FR: 'FL', RL: 'RL', RR: 'RL' },
    settings: { FL: { brake: 'outboard', drive: 'none' }, FR: { brake: 'outboard', drive: 'none' }, RL: { brake: 'outboard', drive: 'chassis' }, RR: { brake: 'outboard', drive: 'chassis' } },
    mass: 300, cg: { x: 0, height: 280, z: -0.47 * 1550 }, wheelbase: 1550, brakeBias: 0.6, driveSplit: 0.5, autoPreload: true,
    shared: { front: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } }, rear: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } } },
    dropLinks: { front: null, rear: null }, droop: 50, bump: 50,
    cases: { lateralG: 1, brakingG: 1, accelG: 0 },
    goals: [], variables: [],
  };

  it('evaluates the load cases: identical front/rear designs split lateral transfer by weight, roll ~1°/g', () => {
    const e = evaluateVehicle(base, { FL: geom, RL: geom })!;
    expect(e.cases.map((c) => c.name)).toEqual(['lateral', 'braking']);
    expect(vehicleGoalValue('lltd', base, e)!).toBeCloseTo(50.4, 0);
    expect(vehicleGoalValue('roll', base, e)!).toBeGreaterThan(0.5);
    expect(vehicleGoalValue('pitch', base, e)!).toBeGreaterThan(0); // nose down under braking
    expect(vehicleGoalValue('grip', base, e)!).toBeGreaterThan(0.9);
  });

  it('moves the front and rear roll centers to reach a load-transfer split, only within the ranges', () => {
    const vars: VehicleVariable[] = (['FL', 'RL'] as const).flatMap((root) => (['ucaFwd', 'ucaAft'] as const).map((k) => {
      const v = geom.uca[k === 'ucaFwd' ? 'fwd' : 'aft'].y;
      return { root, point: k, axis: 1 as const, lo: v - 40, hi: v + 40 };
    }));
    const r = optimizeVehicle({ ...base, goals: [{ kind: 'lltd', target: 55, weight: 1 }], variables: vars });
    expect(r.goals[0]!.after!).toBeCloseTo(55, 0);
    for (const v of r.variables) {
      expect(v.after).toBeGreaterThanOrEqual(v.lo - 1e-9);
      expect(v.after).toBeLessThanOrEqual(v.hi + 1e-9);
    }
    // Only the UCA moved.
    expect(r.geometries.FL!.lca).toEqual(geom.lca);
    expect(r.geometries.RL!.tieRod).toEqual(geom.tieRod);
  });
});
