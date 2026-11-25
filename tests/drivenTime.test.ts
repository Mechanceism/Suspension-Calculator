import { describe, it, expect } from 'vitest';
import { rideRun, DEFAULT_MF, type VehicleProblem, type TireForceModel, type SegmentSpec } from '../src/core';
import { testScore, rideScore, lapRideScore } from '../src/core/tests/score';
import type { TestRun } from '../src/core/tests/run';
import { SAMPLE_LAYOUTS, SAMPLE_SPRING } from '../src/examples/sampleLayouts';
import { driverSpeedOf } from '../src/app/tests';

// Round 4: a test's time is how long the car took as driven — the pedal driver within its tires as they are each
// moment (not one grip estimate) and its powertrain — not the plan's; lap tests are scored on it (F9).
const geom = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
const profile = { radius: 260, width: 205, shoulderRadius: 25, rimRadius: 165 };
const gas: TireForceModel = { kind: 'gas', volumeChange: true, volumeFactor: 1, conditions: { setPressure: 83, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 } };
const des = { geometry: geom, profile, model: gas, springRate: SAMPLE_SPRING.rate, freeLength: SAMPLE_SPRING.freeLength, unsprungMass: 12, damping: { bump: 1500, rebound: 2500 } };
const base = (over: Partial<VehicleProblem> = {}): VehicleProblem => ({
  designs: { FL: des }, roots: { FL: 'FL', FR: 'FL', RL: 'FL', RR: 'FL' },
  settings: { FL: { brake: 'outboard', drive: 'none' }, FR: { brake: 'outboard', drive: 'none' }, RL: { brake: 'outboard', drive: 'chassis' }, RR: { brake: 'outboard', drive: 'chassis' } },
  mass: 300, cg: { x: 0, height: 280, z: -0.47 * 1550 }, wheelbase: 1550, brakeBias: 0.6, driveSplit: 0.5, autoPreload: true,
  shared: { front: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } }, rear: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } } },
  dropLinks: { front: null, rear: null }, droop: 50, bump: 50, cases: { lateralG: 0, brakingG: 0, accelG: 0 }, goals: [], variables: [],
  steering: { steered: { FL: true, FR: true }, rackLimit: 30, cFactor: 75 },
  ride: { rollInertia: 35, pitchInertia: 100, tireDamping: 100 },
  tireGrip: DEFAULT_MF,
  ...over,
});

describe('the driven time', () => {
  it('rear tires with less grip take longer to drive the same plan (the pedal driver within the tires each moment)', () => {
    // A launch planned at ≈ 0.8 g: 0 → 25 m/s over 40 m.
    const s = Array.from({ length: 41 }, (_, k) => k);
    const plan = { s, v: s.map((x) => Math.sqrt(2 * 0.8 * 9.80665 * x)) };
    const segs: SegmentSpec[] = [{ distance: 40, v0: 0, v1: 25, path: 'straight', radius: 0, grade: 0, bank: 0, plan } as SegmentSpec];
    const geoms = { FL: geom };
    const grippy = rideRun(base(), geoms, segs, { handling: true, driverSpeed: true });
    const slick = rideRun(base({ tireGripRear: { ...DEFAULT_MF, pDx1: 0.45, pDy1: 0.5 } }), geoms, segs, { handling: true, driverSpeed: true });
    const planned = rideRun(base(), geoms, segs, { handling: true });
    expect(grippy.times?.[0]).toBeGreaterThan(0);
    expect(slick.times![0]!).toBeGreaterThan(grippy.times![0]! + 0.1);
    // Without the pedal driver the segment takes the plan's time, whatever the tires.
    expect(planned.times![0]!).toBeCloseTo(2 * 40 / 25, 1);
  }, 120000);

  it('planned speeds always use the pedal driver (with the driver steering over time); set speeds only when ticked', () => {
    expect(driverSpeedOf({ speedMode: 'grip', ride: true, handling: true })).toBe(true);
    expect(driverSpeedOf({ speedMode: 'max', ride: true, handling: true })).toBe(true);
    expect(driverSpeedOf({ speedMode: 'grip', ride: true, handling: false })).toBe(false);
    expect(driverSpeedOf({ speedMode: 'hold', ride: true, handling: true })).toBe(false);
    expect(driverSpeedOf({ speedMode: 'hold', ride: true, handling: true, driverSpeed: true })).toBe(true);
  });

  it('a lap test is scored on its time: of the ride only bump-stop time counts (a tenth); set-speed tests keep the whole ride part (F9)', () => {
    const metrics = { liftTime: 1, bumpStopTime: 0.4, loadVariation: 0.3, heaveAccRms: 2, maxPathError: 0.8, maxSideslip: 6 } as Parameters<typeof rideScore>[0];
    const run = (time?: number): TestRun => ({
      severity: 'pass', passed: true, states: [], segments: [], ride: { frames: [], metrics: metrics! }, ...(time !== undefined ? { time } : {}),
    });
    expect(lapRideScore(metrics)).toBeCloseTo(0.2, 9);
    expect(testScore(run(), 'pass')).toBeCloseTo(rideScore(metrics), 6); // set speeds: the whole ride part
    expect(testScore(run(50), 'pass')).toBeCloseTo(0.2, 6); // a lap test: bump-stop time only
    // 1 % faster = 1 point at weight 1.
    expect(testScore(run(50), 'pass', { weight: 1, ref: 50 }) - testScore(run(49.5), 'pass', { weight: 1, ref: 50 })).toBeCloseTo(1, 9);
  });
});

describe('off the line: a lane as a share of the car width', () => {
  it('200 % by default: half the car width either side; older metre settings read as lane %', async () => {
    const { laneShare, PROFILES, classifyState } = await import('../src/core/tests/checks');
    expect(PROFILES.default.checks.pathError.threshold).toBe(200);
    expect(laneShare(200)).toBe(2);
    expect(laneShare(1)).toBe(2); // the old 1 m
    expect(laneShare(2)).toBe(3);
    const facts = (pathError: number) => ({ result: null, lateralG: 0, rolloverG: 9, weight: 3000, brakeForce: 0, requiredG: 0, availableG: 1, handling: { pathError, sideslip: 0, atLock: false, carWidth: 1.4 } });
    const off = (e: number) => classifyState(facts(e) as never, PROFILES.default.checks).some((f) => f.check === 'pathError');
    expect(off(0.69)).toBe(false);
    expect(off(0.71)).toBe(true);
  });
});
