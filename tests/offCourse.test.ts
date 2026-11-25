import { describe, it, expect } from 'vitest';
import { rideRun, runTest, DEFAULT_MF, type VehicleProblem, type TireForceModel, type SegmentSpec } from '../src/core';
import { offCourseOf, offCourseLimit, OFF_COURSE_WIDTHS } from '../src/core/tests/ride';
import { SAMPLE_LAYOUTS, SAMPLE_SPRING } from '../src/examples/sampleLayouts';

// Round 4 (F25): a car that leaves the course or spins stops — the run ends there (did not finish) — instead of
// driving on, weaving or crawling backwards far from the course (user report: the mower on the Rally stage).
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
const seg = (path: 'left' | 'right' | 'straight', radius: number, distance: number, v: number, v1 = v): SegmentSpec => ({ distance, v0: v, v1, path, radius, grade: 0, bank: 0 });

describe('off course / spun ends the run (F25)', () => {
  it('the limits: twice the car width off the line (at least a width past the lane), or turned past 90°', () => {
    expect(offCourseLimit(1.5, 2)).toBeCloseTo(OFF_COURSE_WIDTHS * 1.5, 9);
    // A wide lane (Drift's 300 %: a width either side) still leaves a width past it.
    expect(offCourseLimit(1.5, 3)).toBeCloseTo(3, 9);
    expect(offCourseLimit(1.5, 5)).toBeCloseTo(4.5, 9);
    expect(offCourseOf(1, 0.3, 3)).toBeNull();
    expect(offCourseOf(-3.2, 0.3, 3)?.why).toBe('offCourse');
    expect(offCourseOf(-3.2, 0.3, 3)?.text).toMatch(/right of the line/);
    expect(offCourseOf(0.5, 1.7, 3)?.why).toBe('spun');
    expect(offCourseOf(0.5, -4, 3)?.text).toMatch(/around/);
  });

  it('too fast for a turn: it runs off, the run ends there (a Fail), nothing after it is driven', () => {
    const segs = [seg('straight', 0, 20, 18), seg('left', 30, 120, 18), seg('straight', 0, 100, 18)];
    const r = rideRun(base(), { FL: geom }, segs, { handling: true });
    expect(r.ended).toBeDefined();
    expect(r.ended!.segment).toBe(1);
    const f = r.findings[1]!.find((x) => x.check === 'offCourse');
    expect(f?.severity).toBe('fail');
    expect(f?.text).toMatch(/did not finish/);
    // Stops right there: the last frame is the one where it left, a little past the limit, and in segment 1.
    const last = r.frames.at(-1)!;
    expect(last.segment).toBe(1);
    expect(last.t).toBeCloseTo(r.ended!.t, 6);
    // (Off course: past twice the car's width, ≈ 1.6 m here — and not much further: it stopped there.)
    if (r.ended!.why === 'offCourse') expect(Math.abs(last.handling!.pathError)).toBeGreaterThan(2.5);
    expect(r.metrics.maxPathError!).toBeLessThan(4);
    expect(r.findings[2]!).toEqual([]);
    expect(r.times?.[2]).toBeUndefined();
    expect(r.checkpoints?.[3]).toBeUndefined();
  });

  it('a car that stays on the line runs to the end', () => {
    const r = rideRun(base(), { FL: geom }, [seg('left', 20, 40, 0, 10), seg('straight', 0, 30, 10)], { handling: true });
    expect(r.ended).toBeUndefined();
    expect(r.findings.flat().some((x) => x.check === 'offCourse')).toBe(false);
    expect(r.frames.at(-1)!.segment).toBe(1);
  });

  it('runTest: did not finish, the segments after it not reached', () => {
    const segs = [seg('straight', 0, 20, 18), seg('left', 30, 120, 18), seg('straight', 0, 100, 18)];
    const run = runTest(base(), { FL: geom }, segs, { onFail: 'report', ride: true, handling: true });
    expect(run.passed).toBe(false);
    expect(run.ended?.segment).toBe(1);
    expect(run.segments[1]!.findings.some((x) => x.check === 'offCourse' && x.severity === 'fail')).toBe(true);
    expect(run.segments[2]!.notReached).toBe(true);
    expect(run.segments[0]!.notReached).toBeUndefined();
  });
});
