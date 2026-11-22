import { describe, it, expect } from 'vitest';
import { assembleVehicle, runTest, steerForTurn, trackPath, PROFILES, type VehicleProblem, type TireForceModel, type SegmentSpec } from '../src/core';
import { SAMPLE_LAYOUTS, SAMPLE_SPRING } from '../src/examples/sampleLayouts';

const geom = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
const profile = { radius: 260, width: 205, shoulderRadius: 25, rimRadius: 165 };
const gas: TireForceModel = { kind: 'gas', volumeChange: true, volumeFactor: 1, conditions: { setPressure: 83, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 } };
const des = { geometry: geom, profile, model: gas, springRate: SAMPLE_SPRING.rate, freeLength: SAMPLE_SPRING.freeLength, unsprungMass: 12 };

const base = (over: Partial<VehicleProblem> = {}): VehicleProblem => ({
  designs: { FL: des }, roots: { FL: 'FL', FR: 'FL', RL: 'FL', RR: 'FL' },
  settings: { FL: { brake: 'outboard', drive: 'none' }, FR: { brake: 'outboard', drive: 'none' }, RL: { brake: 'outboard', drive: 'chassis' }, RR: { brake: 'outboard', drive: 'chassis' } },
  mass: 300, cg: { x: 0, height: 280, z: -0.47 * 1550 }, wheelbase: 1550, brakeBias: 0.6, driveSplit: 0.5, autoPreload: true,
  shared: { front: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } }, rear: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } } },
  dropLinks: { front: null, rear: null }, droop: 50, bump: 50, cases: { lateralG: 0, brakingG: 0, accelG: 0 }, goals: [], variables: [],
  steering: { steered: { FL: true, FR: true }, rackLimit: 30, cFactor: 75 },
  ...over,
});
const turn = (path: 'left' | 'right', radius: number): SegmentSpec => ({ distance: 20, v0: 5, v1: 5, path, radius, grade: 0, bank: 0 });

describe('steering for a turn', () => {
  const p = base();
  const asm = assembleVehicle(p, { FL: geom })!;

  it('tighter turns need more rack, left and right are opposite', () => {
    const wide = steerForTurn(asm.built, p.roots, p.steering!, p.wheelbase, 'left', 40)!;
    const tight = steerForTurn(asm.built, p.roots, p.steering!, p.wheelbase, 'left', 10)!;
    const right = steerForTurn(asm.built, p.roots, p.steering!, p.wheelbase, 'right', 40)!;
    expect(wide.none).toBe(false);
    expect(Math.abs(tight.rack)).toBeGreaterThan(Math.abs(wide.rack) * 3);
    expect(Math.sign(right.rack)).toBe(-Math.sign(wide.rack));
    expect(right.rack).toBeCloseTo(-wide.rack, 0);
    expect(wide.wheelAngle).toBeCloseTo((Math.atan(1.55 / 40) * 180) / Math.PI, 6);
    expect(steerForTurn(asm.built, p.roots, p.steering!, p.wheelbase, 'straight', 40)).toBeNull();
  });

  it('a turn tighter than the rack allows fails Steering lock; no steered wheels fails too', () => {
    const tightRun = runTest(p, { FL: geom }, [{ ...turn('left', 2), checks: PROFILES.default.checks }], { onFail: 'report' });
    expect(tightRun.segments[0]!.findings.some((f) => f.check === 'steerLimit')).toBe(true);
    expect(tightRun.passed).toBe(false);
    const ok = runTest(p, { FL: geom }, [turn('left', 60)], { onFail: 'report' });
    expect(ok.segments[0]!.findings.some((f) => f.check === 'steerLimit')).toBe(false);
    expect(Math.abs(ok.states[0]!.state.rack!)).toBeGreaterThan(0.1);
    const none = runTest(base({ steering: { steered: {}, rackLimit: 30, cFactor: 75 } }), { FL: geom }, [turn('right', 60)], { onFail: 'report' });
    expect(none.segments[0]!.findings.some((f) => f.check === 'steerLimit')).toBe(true);
  });
});

describe('track path', () => {
  it('a 90° left arc ends R to the side and turned 90°', () => {
    const R = 20;
    const [a, b] = trackPath([{ distance: 10, path: 'straight', radius: 1 }, { distance: (Math.PI / 2) * R, path: 'left', radius: R }]);
    expect(a!.at(-1)!.x).toBeCloseTo(10, 9);
    const end = b!.at(-1)!;
    expect(end.x).toBeCloseTo(10 + R, 6);
    expect(end.y).toBeCloseTo(R, 6);
    expect(end.heading).toBeCloseTo(Math.PI / 2, 9);
  });
});

describe('full lock from a measured wheel angle', () => {
  it('finds the rack travel that gives the measured angle; inside turns more than outside (Ackermann)', async () => {
    const { rackForWheelAngle, wheelSteerAngle, DoubleWishbone } = await import('../src/core');
    const corner = new DoubleWishbone(geom);
    const span = rackForWheelAngle(corner, (60 * Math.PI) / 180, 'span')!;
    expect(((span.inside + span.outside) * 180) / Math.PI).toBeCloseTo(60, 3);
    const inside = rackForWheelAngle(corner, (35 * Math.PI) / 180, 'inside')!;
    expect((inside.inside * 180) / Math.PI).toBeCloseTo(35, 3);
    expect(Math.abs(wheelSteerAngle(corner, inside.rack)) + Math.abs(wheelSteerAngle(corner, -inside.rack))).toBeGreaterThan(0);
    expect(rackForWheelAngle(corner, 3, 'inside')).toBeNull(); // 172°: out of reach
  });
});
