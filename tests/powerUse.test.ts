import { describe, expect, it } from 'vitest';
import { powerUse } from '../src/core/tests/powerUse';
import { planSpeeds, combinedLimit, type PlanCar } from '../src/core/tests/plan';
import { G, type SegmentSpec } from '../src/core/tests/segments';
import { wheelDrive, type Powertrain } from '../src/core/vehicle/powertrain';

// Round 4 (F7): what a planned test asks of the powertrain.
describe('powertrain use of a planned test', () => {
  const car: PlanCar = {
    muFront: 1, muRear: 1, frontShare: 0.5, cgHeight: 500, wheelbase: 2500, track: 1500, brakeBias: 0.65, driveSplit: 0,
    brakesFront: true, brakesRear: true, drivenFront: false, drivenRear: true, mass: 1000, rollingResistance: 0.01,
  };
  const segs: SegmentSpec[] = [
    { distance: 400, v0: 0, v1: 30, path: 'straight', radius: 0, grade: 0, bank: 0 },
    { distance: 60, v0: 30, v1: 30, path: 'left', radius: 40, grade: 0, bank: 0 },
  ];
  const r = 0.3;
  const pt: Powertrain = { kind: 'electric', peakTorque: 250, peakPower: 60, maxRpm: 16000, ratio: 8, efficiency: 0.9 };

  it('the wheel power and torque, rpm, and what limits it flat out: the tires off the line, then the power', () => {
    const drive = (v: number) => wheelDrive(pt, v, r).force;
    const { plans } = planSpeeds(segs, { ...car, drive }, [0.95, 0.95], [], { gripOnly: { topSpeed: 1e9 } });
    const u = powerUse(plans, segs, { ...car, drive }, [0.95, 0.95], r, pt);
    const T = u.total;
    expect(T.time).toBeGreaterThan(0);
    expect(T.distance).toBeCloseTo(460, 6);
    // Never more at the motor than it has.
    expect(T.motorPower!).toBeLessThanOrEqual(60 + 0.5);
    expect(T.motorTorque!).toBeLessThanOrEqual(250 + 1e-6);
    expect(T.wheelPower).toBeLessThanOrEqual(60 * 0.9 + 0.5);
    // Off the line the tires limit it (250 N·m · 8 · 0.9 / 0.3 = 6000 N > the rear's ≈ 0.95 · 0.5 g · 1000 kg … ), then the power.
    expect(u.segments[0]!.gripLimited).toBeGreaterThan(0);
    expect(u.segments[0]!.powerLimited).toBeGreaterThan(u.segments[0]!.gripLimited);
    expect(T.powerLimited + T.gripLimited).toBeLessThanOrEqual(T.time + 1e-9);
    // For the tires to be the limit everywhere it needs more than it has.
    expect(T.powerNeeded).toBeGreaterThan(60);
    // The most rpm matches the top speed it reached.
    const vmax = Math.max(...plans.flatMap((p) => p.v));
    expect(T.rpm!).toBeLessThanOrEqual((vmax / r) * (60 / (2 * Math.PI)) * 8 + 1e-6);
  });

  it('without a powertrain: the tires the only limit; the power the tires alone would need', () => {
    const { plans } = planSpeeds(segs, car, [0.95, 0.95], [], { gripOnly: { topSpeed: 30 } });
    const u = powerUse(plans, segs, car, [0.95, 0.95], r);
    expect(u.total.powerLimited).toBe(0);
    expect(u.total.gripLimited).toBeGreaterThan(0);
    expect(u.total.rpm).toBeUndefined();
    // Flat out on the straight just before 30 m/s: the tires' push × the speed.
    const tires = car.mass * G * combinedLimit(car, 0.95, 0, 'drive');
    expect(u.total.powerNeeded).toBeGreaterThan((tires * 25) / 1000);
    expect(u.total.powerNeeded).toBeLessThanOrEqual((tires * 30) / 1000 + 1e-6);
  });
});
