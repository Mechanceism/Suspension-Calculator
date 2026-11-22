import { describe, it, expect } from 'vitest';
import { brakeCapacity, pedalForceNeeded, assembleVehicle, solveCase, classifyState, PROFILES, type BrakeSystem, type VehicleProblem, type TireForceModel } from '../src/core';
import { SAMPLE_LAYOUTS, SAMPLE_SPRING } from '../src/examples/sampleLayouts';

const axle = { mcBore: 19.05, pistonDiameter: 32, pistonsPerSide: 2, padMu: 0.45, rotorRadius: 100 };
const sys: BrakeSystem = { maxPedalForce: 400, pedalRatio: 4, boost: 1, dualMc: false, balanceFront: 0.5, front: axle, rear: { ...axle, pistonsPerSide: 1 } };

describe('brake hydraulics', () => {
  it('pedal → line pressure → clamp → torque → tire force (hand check)', () => {
    const c = brakeCapacity(sys, { front: 260, rear: 260 });
    const p = (400 * 4) / ((Math.PI / 4) * 19.05 ** 2); // MPa
    expect(c.pressure.front / 1000).toBeCloseTo(p, 9);
    const fric = 2 * 0.45 * p * 2 * (Math.PI / 4) * 32 ** 2;
    expect(c.torque.front).toBeCloseTo((fric * 100) / 1000, 6);
    expect(c.axleForce.front).toBeCloseTo((2 * fric * 100) / 260, 6);
    // Rear has half the piston area: the hydraulics put 2/3 of the braking on the front.
    expect(c.bias).toBeCloseTo(2 / 3, 9);
    // Dual master cylinders: the balance bar splits the pedal force.
    const d = brakeCapacity({ ...sys, dualMc: true, balanceFront: 0.6, rear: axle }, { front: 260, rear: 260 });
    expect(d.bias).toBeCloseTo(0.6, 9);
    // Linear in pedal force.
    expect(pedalForceNeeded({ front: c.axleForce.front / 2, rear: 0 }, c.axleForce, 400)).toBeCloseTo(200, 6);
  });

  it('a hard stop beyond the brakes fails "Brakes too weak"; strong brakes pass', () => {
    const geom = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
    const gas: TireForceModel = { kind: 'gas', volumeChange: true, volumeFactor: 1, conditions: { setPressure: 83, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 } };
    const base: VehicleProblem = {
      designs: { FL: { geometry: geom, profile: { radius: 260, width: 205, shoulderRadius: 25, rimRadius: 165 }, model: gas, springRate: SAMPLE_SPRING.rate, freeLength: SAMPLE_SPRING.freeLength, unsprungMass: 12 } },
      roots: { FL: 'FL', FR: 'FL', RL: 'FL', RR: 'FL' },
      settings: { FL: { brake: 'outboard', drive: 'none' }, FR: { brake: 'outboard', drive: 'none' }, RL: { brake: 'outboard', drive: 'chassis' }, RR: { brake: 'outboard', drive: 'chassis' } },
      mass: 300, cg: { x: 0, height: 280, z: -0.47 * 1550 }, wheelbase: 1550, brakeBias: 0.6, driveSplit: 0.5, autoPreload: true,
      shared: { front: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } }, rear: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } } },
      dropLinks: { front: null, rear: null }, droop: 50, bump: 50, cases: { lateralG: 0, brakingG: 0, accelG: 0 }, goals: [], variables: [],
    };
    const run = (cap: { front: number; rear: number }) => {
      const p = { ...base, brakeLimit: { ...cap, maxPedal: 400 } };
      const asm = assembleVehicle(p, { FL: geom })!;
      const r = solveCase(p, asm, { name: 'b', kind: 'state', g: 1.2, lateralG: 0, brakingG: 1.2, accelG: 0 })!.result;
      const facts = { result: r, lateralG: 0, rolloverG: 2, weight: 3000, brakeForce: 3500, requiredG: 1.2, availableG: 2 };
      return { r, checks: classifyState(facts, PROFILES.default.checks).map((f) => f.check) };
    };
    const weak = run({ front: 1000, rear: 600 });
    expect(weak.r.unmet.brakeCapacity).toBe(true);
    expect(weak.checks).toContain('brakeLimit');
    expect(weak.r.brakePedal!.needed).toBeGreaterThan(400);
    const strong = run({ front: 8000, rear: 5000 });
    expect(strong.r.unmet.brakeCapacity).toBeFalsy();
    expect(strong.checks).not.toContain('brakeLimit');
    // 1.2 g on 300 kg = 3530 N: front 60 % of 8000 N → 106 N of pedal, rear 40 % of 5000 N → 113 N: the rear sets it.
    const F = 300 * 9.80665 * 1.2;
    expect(strong.r.brakePedal!.needed).toBeCloseTo(Math.max((F * 0.6) / 8000, (F * 0.4) / 5000) * 400, 3);
  });
});
