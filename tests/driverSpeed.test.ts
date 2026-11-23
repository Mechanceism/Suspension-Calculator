import { describe, it, expect } from 'vitest';
import { rideRun, DEFAULT_MF, type VehicleProblem, type TireForceModel, type SegmentSpec } from '../src/core';
import { SAMPLE_LAYOUTS, SAMPLE_SPRING } from '../src/examples/sampleLayouts';

const geom = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
const gas: TireForceModel = { kind: 'gas', volumeChange: true, volumeFactor: 1, conditions: { setPressure: 83, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 } };
const base = (_r?: number): VehicleProblem => ({
  designs: { FL: { geometry: geom, profile: { radius: 260, width: 205, shoulderRadius: 25, rimRadius: 165 }, model: gas, springRate: SAMPLE_SPRING.rate, freeLength: SAMPLE_SPRING.freeLength, unsprungMass: 12, damping: { bump: 1500, rebound: 2500 } } },
  roots: { FL: 'FL', FR: 'FL', RL: 'FL', RR: 'FL' },
  settings: { FL: { brake: 'outboard', drive: 'none' }, FR: { brake: 'outboard', drive: 'none' }, RL: { brake: 'outboard', drive: 'chassis' }, RR: { brake: 'outboard', drive: 'chassis' } },
  mass: 300, cg: { x: 0, height: 280, z: -0.47 * 1550 }, wheelbase: 1550, brakeBias: 0.6, driveSplit: 0.5, autoPreload: true,
  shared: { front: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } }, rear: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } } },
  dropLinks: { front: null, rear: null }, droop: 50, bump: 50, cases: { lateralG: 0, brakingG: 0, accelG: 0 }, goals: [], variables: [],
  steering: { steered: { FL: true, FR: true }, rackLimit: 30, cFactor: 75 },
  ride: { rollInertia: 35, pitchInertia: 100, tireDamping: 100 },
  tireGrip: DEFAULT_MF,
});
const seg = (path: 'left' | 'straight', radius: number, distance: number, v: number): SegmentSpec => ({ distance, v0: v, v1: v, path, radius, grade: 0, bank: 0 });
const run = (relax?: number) => rideRun(base(relax), { FL: geom }, [seg('straight', 0, 20, 14), seg('left', 40, 120, 14)], { handling: true });

describe('driver working the throttle and brakes', () => {
  it('on a gentle course the speed follows the targets', () => {
    const r = rideRun(base(), { FL: geom }, [{ distance: 60, v0: 8, v1: 16, path: 'straight', radius: 0, grade: 0, bank: 0 }, seg('left', 40, 40, 16)], { handling: true, driverSpeed: true });
    expect(r.error).toBeUndefined();
    const endOf = (i: number) => r.frames.filter((f) => f.segment === i).at(-1)!;
    expect(endOf(0).speed).toBeCloseTo(16, 0);
    expect(Math.abs(endOf(1).speed - 16)).toBeLessThan(1);
    expect(r.findings.flat().some((f) => f.text.startsWith('The driver'))).toBe(false);
  });
  it('a turn too fast for the tires: the driver slows for it, stays nearer the line, and it is reported', () => {
    const segs = [seg('straight', 0, 30, 17), seg('left', 15, 50, 17)]; // ≈ 2 g: beyond the tires
    const held = rideRun(base(), { FL: geom }, segs, { handling: true });
    const drv = rideRun(base(), { FL: geom }, segs, { handling: true, driverSpeed: true });
    expect(drv.metrics.maxPathError!).toBeLessThan(held.metrics.maxPathError!);
    expect(drv.frames.filter((f) => f.segment === 1).at(-1)!.speed).toBeLessThan(16);
    expect(drv.findings[1]!.some((f) => f.check === 'speedNotReached' && f.text.startsWith('The driver'))).toBe(true);
  });
  it('without powered wheels the driver can\'t speed up', () => {
    const p = { ...base(), settings: { FL: { brake: 'outboard', drive: 'none' }, FR: { brake: 'outboard', drive: 'none' }, RL: { brake: 'outboard', drive: 'none' }, RR: { brake: 'outboard', drive: 'none' } } } as VehicleProblem;
    const r = rideRun(p, { FL: geom }, [{ distance: 40, v0: 8, v1: 14, path: 'straight', radius: 0, grade: 0, bank: 0 }], { handling: true, driverSpeed: true });
    expect(r.frames.at(-1)!.speed).toBeCloseTo(8, 0);
  });
});
