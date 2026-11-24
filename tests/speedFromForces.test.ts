import { describe, it, expect } from 'vitest';
import { defaultDesign, type AppState } from '../src/app/store';
import { buildVehicleProblem } from '../src/app/optimizer';
import { newSegment, newFeature, segmentSpec } from '../src/app/tests';
import { serializeProject, importProject, FORMAT_VERSION } from '../src/app/project';
import { assembleVehicle, forceSetup, vehicleInputOf, PROFILES, type VehicleProblem } from '../src/core';
import { rideOn } from '../src/core/tests/ride';

const G = 9.80665;
const f = (v: number) => ({ text: String(v), value: v });

/** The default car (front steers, rear powered) with a rolling resistance. */
function problemWith(crr: number): VehicleProblem {
  const d = defaultDesign();
  d.vehicle = { ...d.vehicle, rollingResistance: f(crr) };
  return buildVehicleProblem(d as unknown as AppState).problem;
}
const ride = (p: VehicleProblem, segs: ReturnType<typeof newSegment>[]) => {
  const geoms = Object.fromEntries(Object.entries(p.designs).map(([r, d]) => [r, d!.geometry]));
  const asm = assembleVehicle(p, geoms)!;
  return rideOn(p, asm, segs.map((s) => segmentSpec(s)), { handling: true, driverSpeed: true });
};
const lastSpeed = (r: ReturnType<typeof ride>) => r.frames.at(-1)!.speed;

describe('speed from forces (driver working the pedals)', () => {
  it('coasting on a flat, smooth road with no air and no rolling resistance keeps its speed exactly', () => {
    const r = ride(problemWith(0), [newSegment({ name: 'Coast', distance: f(150), speedStart: f(15), speedEnd: f(15), coast: true })]);
    expect(Math.abs(lastSpeed(r) - 15)).toBeLessThan(1e-6);
    expect(r.metrics.bumpWork).toBeCloseTo(0, 6);
  });

  it('rolling resistance slows a coasting car by μ_r · g per metre (½ v² falls by μ_r g d)', () => {
    const crr = 0.012, d = 150, v0 = 15;
    const r = ride(problemWith(crr), [newSegment({ name: 'Coast', distance: f(d), speedStart: f(v0), speedEnd: f(v0), coast: true })]);
    const v1 = lastSpeed(r);
    const expected = Math.sqrt(v0 * v0 - 2 * crr * G * d);
    expect(v1).toBeLessThan(v0);
    expect(Math.abs(v1 - expected) / (v0 - expected)).toBeLessThan(0.05);
    // Not coasting: the powered wheels push against it and hold the speed.
    const held = ride(problemWith(crr), [newSegment({ name: 'Hold', distance: f(d), speedStart: f(v0), speedEnd: f(v0) })]);
    expect(Math.abs(lastSpeed(held) - v0)).toBeLessThan(0.1);
  });

  it('bumps push back: a coasting car loses the energy the dampers and tires turn into heat', () => {
    const r = ride(problemWith(0), [
      newSegment({ name: 'Bump', distance: f(30), speedStart: f(10), speedEnd: f(10), coast: true, features: [{ ...newFeature('bump', 10), height: f(40) }] }),
      newSegment({ name: 'Settle', distance: f(40), speedStart: f(10), speedEnd: f(10), coast: true }),
    ]);
    const m = buildVehicleProblem(defaultDesign() as unknown as AppState).problem.mass;
    const v1 = lastSpeed(r);
    const keLoss = 0.5 * m * (10 * 10 - v1 * v1);
    expect(v1).toBeLessThan(10);
    // The push took exactly what the road's work on the tires was (by construction, to the step)...
    expect(Math.abs(keLoss - r.metrics.bumpWork!) / r.metrics.bumpWork!).toBeLessThan(0.05);
    // ...and once the car has settled that is what the dampers and the tires' damping dissipated.
    expect(r.metrics.dissipated!).toBeGreaterThan(0);
    expect(Math.abs(r.metrics.bumpWork! - r.metrics.dissipated!) / r.metrics.dissipated!).toBeLessThan(0.2);
  });

  it('kickback: a one-sided bump jolts the steering wheel; both sides at once hardly does', () => {
    const one = ride(problemWith(0), [newSegment({ name: 'One side', distance: f(40), speedStart: f(15), speedEnd: f(15), features: [{ ...newFeature('bump', 15), height: f(40), side: 'left' }] })]);
    const both = ride(problemWith(0), [newSegment({ name: 'Both', distance: f(40), speedStart: f(15), speedEnd: f(15), features: [{ ...newFeature('bump', 15), height: f(40) }] })]);
    expect(one.metrics.maxKickback!).toBeGreaterThan(0.5);
    expect(one.metrics.maxKickback!).toBeGreaterThan(3 * both.metrics.maxKickback!);
    // With a tight limit it's reported.
    const strict = { ...newSegment({ name: 'One side', distance: f(40), speedStart: f(15), speedEnd: f(15), features: [{ ...newFeature('bump', 15), height: f(40), side: 'left' as const }] }) };
    const p = problemWith(0);
    const geoms = Object.fromEntries(Object.entries(p.designs).map(([r, d]) => [r, d!.geometry]));
    const spec = { ...segmentSpec(strict), checks: { ...PROFILES.default.checks, kickback: { severity: 'warn' as const, threshold: 0.1 } } };
    const run = rideOn(p, assembleVehicle(p, geoms)!, [spec], { handling: true, driverSpeed: true });
    expect(run.findings[0]!.some((x) => x.check === 'kickback')).toBe(true);
  });

  it('steady states: the powered wheels push against the rolling resistance too', () => {
    const p = problemWith(0.015);
    const geoms = Object.fromEntries(Object.entries(p.designs).map(([r, d]) => [r, d!.geometry]));
    const asm = assembleVehicle(p, geoms)!;
    const fs = forceSetup(vehicleInputOf(p, asm, { lateralG: 0, brakingG: 0, accelG: 0, speed: 20 }));
    expect(fs.driveTotal).toBeCloseTo(0.015 * p.mass * G, 6);
    // At standstill nothing rolls.
    expect(forceSetup(vehicleInputOf(p, asm, { lateralG: 0, brakingG: 0, accelG: 0 })).driveTotal).toBe(0);
  });

  it('saves; format 39 files get no rolling resistance (results as before) and segments that don\'t coast', () => {
    const d = defaultDesign();
    expect(d.vehicle.rollingResistance.value).toBe(0.012);
    d.tests = [{ id: 't', name: 'T', checks: undefined as never, profile: 'default', rank: 1, onFail: 'report', enabled: true, segments: [newSegment({ coast: true })] } as never];
    const back = importProject(JSON.parse(JSON.stringify(serializeProject(d, 'S'))));
    expect(back.design.tests[0]!.segments[0]!.coast).toBe(true);
    const old = JSON.parse(JSON.stringify(serializeProject(defaultDesign(), 'O')));
    old.formatVersion = 39;
    delete old.vehicle.fields.rollingResistance;
    const r = importProject(old);
    expect(r.warnings).toEqual(Array.from({ length: FORMAT_VERSION - 39 }, (_, i) => `Upgraded from file format ${i + 39} to ${i + 40}.`));
    expect(r.design.vehicle.rollingResistance.value).toBe(0);
  });
});
