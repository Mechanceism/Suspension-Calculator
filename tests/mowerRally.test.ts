import { describe, expect, it } from 'vitest';
import { planSpeeds, type PlanCar } from '../src/core/tests/plan';
import type { SegmentSpec } from '../src/core/tests/segments';
import { rpmTopSpeed } from '../src/core/vehicle/powertrain';
import { assembleVehicle, runTest } from '../src/core';
import { vehicleInputOf } from '../src/core/optimize/vehicle';
import { solveVehicle } from '../src/core/vehicle/vehicle';
import { carProfileDesign } from '../src/app/carProfiles';
import type { AppState } from '../src/app/store';
import { buildVehicleProblem } from '../src/app/optimizer';
import { TEST_PRESETS, segmentSpec, planOption } from '../src/app/tests';

// Round 4 (F26), found with the riding lawnmower on the Rally stage: (a) the plan let it roll down the 8 %
// downhill to 3 × its top speed (it then spun); (b) every rough-ground steady state "couldn't settle".
const mower = () => buildVehicleProblem(carProfileDesign('mower') as unknown as AppState).problem;
const geomsOf = (p: ReturnType<typeof mower>) => Object.fromEntries(Object.entries(p.designs).map(([r, d]) => [r, d!.geometry]));
const seg = (o: Partial<SegmentSpec>): SegmentSpec => ({ distance: 100, v0: 10, v1: 10, path: 'straight', radius: 0, grade: 0, bank: 0, ...o });

describe('a powertrain caps the planned speed at its gearing (F26a)', () => {
  const car: PlanCar = {
    muFront: 1, muRear: 1, frontShare: 0.5, cgHeight: 500, wheelbase: 2500, track: 1500, brakeBias: 0.65, driveSplit: 0,
    brakesFront: true, brakesRear: true, drivenFront: false, drivenRear: true, mass: 1000, drive: (v) => (v < 10 ? 3000 : 0),
  };
  it('down a hill the plan holds the gear top speed (the driver brakes), on the level as before', () => {
    const segs = [seg({ v0: 0, distance: 100 }), seg({ distance: 200, grade: -0.08 })];
    const free = planSpeeds(segs, car, [0.95, 0.95], [], { gripOnly: { topSpeed: 30 } });
    const held = planSpeeds(segs, { ...car, gearTop: 10 }, [0.95, 0.95], [], { gripOnly: { topSpeed: 30 } });
    expect(Math.max(...free.plans[1]!.v)).toBeGreaterThan(15); // gravity alone took it there
    expect(Math.max(...held.plans.flatMap((pl) => pl.v))).toBeLessThanOrEqual(10 + 1e-9);
    expect(Math.max(...held.plans[1]!.v)).toBeCloseTo(10, 6);
  });

  it('the mower on the Rally stage: planned at its 9 km/h at most (the downhill included); every rough sample settles (F26b)', () => {
    const p = mower();
    const t = { ...TEST_PRESETS.find((x) => x.label.startsWith('Rally stage'))!.make(), id: 'r' };
    const run = runTest(p, geomsOf(p) as never, t.segments.map((s) => segmentSpec(s, t)), { onFail: 'report', ...planOption(t) });
    const asm = assembleVehicle(p, geomsOf(p) as never)!;
    const top = rpmTopSpeed(p.powertrain!, (asm.chars.RL.wheelCenter.y - asm.chars.RL.contactPoint.y) / 1000);
    expect(top * 3.6).toBeGreaterThan(8);
    expect(top * 3.6).toBeLessThan(10);
    const vmax = Math.max(...run.segments.flatMap((s) => s.plan?.v ?? []));
    expect(vmax).toBeLessThanOrEqual(top * 1.001);
    // No "can't settle", no Infinity % grip.
    const all = run.segments.flatMap((s) => s.findings);
    expect(all.filter((f) => f.check === 'noSolution')).toEqual([]);
    expect(all.some((f) => /Infinity/.test(f.text))).toBe(false);
  }, 240000);
});

describe('resting on uneven ground (F26b)', () => {
  it('with wheels starting past their droop the car still settles on all four (ground brought in from level)', () => {
    const p = mower();
    const asm = assembleVehicle(p, geomsOf(p) as never)!;
    expect(p.droop).toBe(10);
    // Two of the Rally stage's rough patches (mm): the front 14–16 mm lower; the front 30–40 mm lower, the rear 20–27 mm higher.
    for (const groundOffset of [{ FL: -16.44, FR: -14.42, RL: -7.69, RR: -6.65 }, { FL: -30.1, FR: -40, RL: 26.5, RR: 19.5 }]) {
      const r = solveVehicle(vehicleInputOf(p, asm, { lateralG: 0, brakingG: 0, accelG: 0, groundOffset }), {});
      expect(r.converged).toBe(true);
      for (const id of ['FL', 'FR', 'RL', 'RR'] as const) expect(r.corners[id].tireLoad).toBeGreaterThan(100);
      // The body follows the ground (down about the patch's mean), not 800 mm up and pitched 40°.
      expect(Math.abs(r.pose.pitch)).toBeLessThan(0.1);
      expect(Math.abs(r.pose.heave)).toBeLessThan(60);
    }
  });
});
