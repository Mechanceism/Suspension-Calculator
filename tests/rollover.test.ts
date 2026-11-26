import { describe, expect, it } from 'vitest';
import { rolloverStats } from '../src/core/vehicle/rollover';
import { assembleVehicle } from '../src/core';
import { vehicleInputOf } from '../src/core/optimize/vehicle';
import { defaultDesign, type AppState } from '../src/app/store';
import { carProfileDesign } from '../src/app/carProfiles';
import { buildVehicleProblem } from '../src/app/optimizer';

// Round 5 (item 8): how close a car is to tipping.
const statsOf = (d: unknown) => {
  const p = buildVehicleProblem(d as AppState).problem;
  const geoms = Object.fromEntries(Object.entries(p.designs).map(([r, x]) => [r, x!.geometry]));
  const asm = assembleVehicle(p, geoms as never)!;
  return rolloverStats(vehicleInputOf(p, asm, { lateralG: 0, brakingG: 0, accelG: 0 }), p.ride?.rollInertia ?? 0)!;
};

describe('rollover stats', () => {
  it('stability factor, tipping angle and trip speed follow from track, CG height and roll inertia', () => {
    const s = statsOf(defaultDesign());
    const { mass: m, cgHeight, halfTrack, rollInertia } = s.basis;
    const h = cgHeight / 1000, t2 = halfTrack / 1000;
    expect(s.ssf).toBeCloseTo(t2 / h, 9);
    expect(s.tippingAngle).toBeCloseTo((Math.atan(t2 / h) * 180) / Math.PI, 9);
    const reach = Math.hypot(h, t2), Ic = rollInertia + m * reach * reach;
    expect(s.tripSpeed).toBeCloseTo(Math.sqrt(2 * m * 9.80665 * (reach - h) * Ic) / (m * h), 9);
    // More roll inertia, a higher trip speed.
    expect(rollInertia).toBeGreaterThan(35);
  });

  it('the inside wheels lift below the rigid threshold (body roll and tire squash move the CG out); a tall narrow car tips far sooner', () => {
    // (The default car: no lift before its 2.1 g rigid threshold's solve gives up — a road car and a mower.)
    const car = statsOf(carProfileDesign('road'));
    const mower = statsOf(carProfileDesign('mower'));
    for (const s of [car, mower]) {
      expect(s.liftOffG).not.toBeNull();
      expect(s.liftOffG!).toBeLessThan(s.ssf);
      expect(s.liftOffG!).toBeGreaterThan(0.6 * s.ssf);
    }
    expect(mower.ssf).toBeLessThan(car.ssf);
    expect(mower.tippingAngle).toBeLessThan(car.tippingAngle);
    expect(mower.tripSpeed).toBeLessThan(car.tripSpeed);
  }, 180000);
});

describe('rolling over, over time', () => {
  it('a top-heavy car tips in a fast turn: the run ends (Rolled over, a Fail); slower it stays up, with its closest margin', async () => {
    const { rideRun, DEFAULT_MF } = await import('../src/core');
    const { SAMPLE_LAYOUTS, SAMPLE_SPRING } = await import('../src/examples/sampleLayouts');
    const geom = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
    const gas = { kind: 'gas', volumeChange: true, volumeFactor: 1, conditions: { setPressure: 83, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 } } as const;
    const tall = {
      designs: { FL: { geometry: geom, profile: { radius: 260, width: 205, shoulderRadius: 25, rimRadius: 165 }, model: gas, springRate: SAMPLE_SPRING.rate, freeLength: SAMPLE_SPRING.freeLength, unsprungMass: 12, damping: { bump: 1500, rebound: 2500 } } },
      roots: { FL: 'FL', FR: 'FL', RL: 'FL', RR: 'FL' },
      settings: { FL: { brake: 'outboard', drive: 'none' }, FR: { brake: 'outboard', drive: 'none' }, RL: { brake: 'outboard', drive: 'chassis' }, RR: { brake: 'outboard', drive: 'chassis' } },
      // CG 900 mm up on a ≈ 1.2 m track: it tips at ≈ 0.65 g, well inside its tires' grip.
      mass: 300, cg: { x: 0, height: 900, z: -0.47 * 1550 }, wheelbase: 1550, brakeBias: 0.6, driveSplit: 0.5, autoPreload: true,
      shared: { front: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } }, rear: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } } },
      dropLinks: { front: null, rear: null }, droop: 50, bump: 50, cases: { lateralG: 0, brakingG: 0, accelG: 0 }, goals: [], variables: [],
      steering: { steered: { FL: true, FR: true }, rackLimit: 30, cFactor: 75 },
      ride: { rollInertia: 35, pitchInertia: 100, tireDamping: 100 },
      tireGrip: DEFAULT_MF,
    };
    const turn = (v: number) => [
      { distance: 20, v0: v, v1: v, path: 'straight' as const, radius: 0, grade: 0, bank: 0 },
      { distance: 60, v0: v, v1: v, path: 'left' as const, radius: 20, grade: 0, bank: 0 },
    ];
    const fast = rideRun(tall as never, { FL: geom }, turn(13), { handling: true });
    expect(fast.ended?.why).toBe('rolledOver');
    expect(fast.findings[1]!.some((f) => f.check === 'rollover' && f.severity === 'fail' && /Rolled over/.test(f.text))).toBe(true);
    expect(fast.metrics.rollMargin!.margin).toBeLessThan(0);
    const slow = rideRun(tall as never, { FL: geom }, turn(8), { handling: true });
    expect(slow.ended).toBeUndefined();
    // 0.34 g on a car that tips at ≈ 0.65 g: well clear, but it leaned toward the outside.
    expect(slow.metrics.rollMargin!.margin).toBeGreaterThan(0.5);
    expect(slow.metrics.rollMargin!.margin).toBeLessThan(1);
  }, 120000);
});
