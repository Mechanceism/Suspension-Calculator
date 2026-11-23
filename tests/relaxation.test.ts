import { describe, it, expect } from 'vitest';
import { rideRun, handlingCar, handlingForces, stepHandling, assembleVehicle, DEFAULT_MF, type VehicleProblem, type TireForceModel, type SegmentSpec } from '../src/core';
import { SAMPLE_LAYOUTS, SAMPLE_SPRING } from '../src/examples/sampleLayouts';

const geom = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
const gas: TireForceModel = { kind: 'gas', volumeChange: true, volumeFactor: 1, conditions: { setPressure: 83, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 } };
const base = (relaxation?: number): VehicleProblem => ({
  designs: { FL: { geometry: geom, profile: { radius: 260, width: 205, shoulderRadius: 25, rimRadius: 165 }, model: gas, springRate: SAMPLE_SPRING.rate, freeLength: SAMPLE_SPRING.freeLength, unsprungMass: 12, damping: { bump: 1500, rebound: 2500 } } },
  roots: { FL: 'FL', FR: 'FL', RL: 'FL', RR: 'FL' },
  settings: { FL: { brake: 'outboard', drive: 'none' }, FR: { brake: 'outboard', drive: 'none' }, RL: { brake: 'outboard', drive: 'chassis' }, RR: { brake: 'outboard', drive: 'chassis' } },
  mass: 300, cg: { x: 0, height: 280, z: -0.47 * 1550 }, wheelbase: 1550, brakeBias: 0.6, driveSplit: 0.5, autoPreload: true,
  shared: { front: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } }, rear: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } } },
  dropLinks: { front: null, rear: null }, droop: 50, bump: 50, cases: { lateralG: 0, brakingG: 0, accelG: 0 }, goals: [], variables: [],
  steering: { steered: { FL: true, FR: true }, rackLimit: 30, cFactor: 75 },
  ride: { rollInertia: 35, pitchInertia: 100, tireDamping: 100, ...(relaxation !== undefined ? { relaxation } : {}) },
  tireGrip: DEFAULT_MF,
});
const seg = (path: 'left' | 'straight', radius: number, distance: number, v: number): SegmentSpec => ({ distance, v0: v, v1: v, path, radius, grade: 0, bank: 0 });
const run = (relax?: number) => rideRun(base(relax), { FL: geom }, [seg('straight', 0, 20, 14), seg('left', 40, 120, 14)], { handling: true });

describe('tire relaxation length', () => {
  it('0 is the same as none; with a 2 m relaxation length the car still settles into the same steady turn', () => {
    const a = run(), b = run(0), c = run(2000);
    expect(b.frames.at(-1)!.handling!.yawRate).toBeCloseTo(a.frames.at(-1)!.handling!.yawRate, 9);
    expect(c.frames.at(-1)!.handling!.yawRate).toBeCloseTo(14 / 40, 1); // the same steady turn
  });

  it('the side force follows the lagged slip angle, which closes on the geometric one by u·h / σ per step', () => {
    const p = base(500);
    const asm = assembleVehicle(p, { FL: geom })!;
    const car = handlingCar(p, asm, { FL: undefined, FR: undefined, RL: undefined, RR: undefined });
    expect(car.relaxation).toBeCloseTo(0.5, 9);
    const tires = Object.fromEntries((['FL', 'FR', 'RL', 'RR'] as const).map((id) => [id, { fz: 700, gammaLeft: 0, fx: 0 }])) as never;
    const wheels = { FL: 0.05, FR: 0.05, RL: 0, RR: 0 };
    const st = { v: 0, r: 0, eY: 0, ePsi: 0, delta: 0.05, rack: 0, cmd: 0, atLock: false, want: 0.05, K: 0, alphaLag: { FL: 0, FR: 0, RL: 0, RR: 0 } };
    const f0 = handlingForces(car, st, 14, tires, wheels);
    expect(f0.fy.FL).toBeCloseTo(0, 6); // lag still at 0: no side force yet
    expect(f0.alphaGeo!.FL).toBeCloseTo(0.05, 6);
    stepHandling(car, st, 14, 0, f0, 0, 0.05, 0.01);
    expect(st.alphaLag.FL).toBeCloseTo(0.05 * (14 * 0.01) / 0.5, 6);
    expect(Math.abs(handlingForces(car, st, 14, tires, wheels).fy.FL)).toBeGreaterThan(10);
  });
});
