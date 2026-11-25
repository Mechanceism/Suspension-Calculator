import { describe, it, expect } from 'vitest';
import {
  rideRun, runTest, assembleVehicle, steerForTurn, solveCase, slipDifference, steerTable, rackFor, effAt, pathOffset, DEFAULT_MF,
  type VehicleProblem, type TireForceModel, type SegmentSpec,
} from '../src/core';
import { estimateInertia } from '../src/core/setup/measure';
import { SAMPLE_LAYOUTS, SAMPLE_SPRING } from '../src/examples/sampleLayouts';

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
const G = 9.80665;

describe('handling over time (Phase C)', () => {
  it('the steering table follows the kinematics and inverts; past full lock it stops there', () => {
    const p = base();
    const asm = assembleVehicle(p, { FL: geom })!;
    const t = steerTable(p, asm);
    expect(t.none).toBe(false);
    const lock = effAt(t, t.limit, 0);
    expect(Math.abs(lock)).toBeGreaterThan(0.1);
    const half = rackFor(t, lock / 2);
    expect(half.atLock).toBe(false);
    expect(effAt(t, half.rack, 0)).toBeCloseTo(lock / 2, 4);
    const over = rackFor(t, lock * 1.5);
    expect(over.atLock).toBe(true);
    expect(Math.abs(over.rack)).toBeCloseTo(t.limit, 6);
    expect(Math.abs(over.needed)).toBeGreaterThan(t.limit);
    // Preview of a circle: offset ≈ κD²/2 for small D·κ.
    expect(pathOffset(() => 1 / 30, 0, 5)).toBeCloseTo(25 / 30 / 2, 2);
  });

  it('a steady turn is followed: yaw rate u/R, lateral u²/(gR), steering ≈ the steady steering need, small error', () => {
    const p = base();
    const v = 12, R = 30;
    const r = rideRun(p, { FL: geom }, [seg('straight', 0, 20, v), seg('left', R, 80, v), seg('straight', 0, 30, v)], { handling: true });
    expect(r.error).toBeUndefined();
    const turn = r.frames.filter((f) => f.segment === 1);
    const mid = turn[Math.floor(turn.length * 0.7)]!;
    expect(mid.handling!.yawRate).toBeCloseTo(v / R, 2);
    expect(mid.ay).toBeCloseTo((v * v) / (G * R), 1);
    expect(Math.abs(mid.handling!.pathError)).toBeLessThan(0.1);
    const asm = assembleVehicle(p, { FL: geom })!;
    const ay = (v * v) / (G * R);
    const steady = solveCase(p, asm, { name: 's', kind: 'state', g: ay, lateralG: ay, brakingG: 0, accelG: 0 })!.result;
    const need = steerForTurn(asm.built, p.roots, p.steering!, p.wheelbase, 'left', R, slipDifference(steady))!;
    expect(Math.abs(mid.handling!.steer - need.wheelAngle)).toBeLessThan(0.5);
    // Turn-in and -out stay near the line; the whole run passes.
    expect(r.metrics.maxPathError!).toBeLessThan(0.5);
    expect(r.findings.flat().filter((f) => f.severity === 'fail')).toEqual([]);
  });

  it('right turns mirror left turns', () => {
    const run = (path: 'left' | 'right') => rideRun(base(), { FL: geom }, [seg('straight', 0, 15, 12), seg(path, 30, 60, 12)], { handling: true });
    const L = run('left').frames.at(-1)!.handling!, Rr = run('right').frames.at(-1)!.handling!;
    expect(Rr.yawRate).toBeCloseTo(-L.yawRate, 3);
    expect(Rr.steer).toBeCloseTo(-L.steer, 2);
    expect(Rr.pathError).toBeCloseTo(-L.pathError, 3);
  });

  it('too fast for the grip: the front slides, the driver goes to full lock and the car runs off the line', () => {
    const r = rideRun(base(), { FL: geom }, [seg('straight', 0, 20, 18), seg('left', 30, 80, 18)], { handling: true });
    const fails = r.findings[1]!.filter((f) => f.severity === 'fail').map((f) => f.check);
    expect(fails).toContain('pathError');
    expect(r.metrics.maxPathError!).toBeGreaterThan(1);
    expect(r.frames.some((f) => f.handling?.atLock)).toBe(true);
    // The line actually driven is outside the path (right of a left turn).
    expect(r.frames.at(-1)!.handling!.pathError).toBeLessThan(-1);
  });

  it('a rear with much less grip than the front slides out (oversteer / spin)', () => {
    const slick = { ...DEFAULT_MF, pDy1: 0.55, pDx1: 0.6 };
    const r = rideRun(base({ tireGripRear: slick }), { FL: geom }, [seg('straight', 0, 20, 14), seg('left', 30, 60, 14)], { handling: true });
    // Reported (since round 4, F10, a slide is noted; it fails only by what it costs or running off the line).
    const checks = r.findings.flat().map((f) => f.check);
    expect(checks.some((c) => c === 'spin' || c === 'oversteer')).toBe(true);
    expect(r.metrics.maxSideslip!).toBeGreaterThan(3);
  });

  it("without steered wheels the car can't follow a turn", () => {
    const r = rideRun(base({ steering: { steered: {}, rackLimit: 30, cFactor: 75 } }), { FL: geom }, [seg('left', 30, 40, 10)], { handling: true });
    expect(r.findings[0]!.map((f) => f.check)).toContain('pathError');
  });

  it('starting from rest (slow: kinematic) and accelerating through a turn stays on the line', () => {
    const r = rideRun(base(), { FL: geom }, [seg('left', 20, 40, 0, 10)], { handling: true });
    expect(r.frames.every((f) => Number.isFinite(f.handling!.pathError))).toBe(true);
    expect(r.metrics.maxPathError!).toBeLessThan(0.5);
  });

  it('runTest passes the option on; the yaw inertia estimate scales with mass and wheelbase', () => {
    const run = runTest(base(), { FL: geom }, [seg('straight', 0, 10, 10), seg('left', 30, 30, 10)], { onFail: 'report', ride: true, handling: true });
    expect(run.ride!.frames.some((f) => f.handling)).toBe(true);
    const off = runTest(base(), { FL: geom }, [seg('left', 30, 30, 10)], { onFail: 'report', ride: true });
    expect(off.ride!.frames.some((f) => f.handling)).toBe(false);
    expect(estimateInertia(250, 1200, 1550, 300).yaw).toBeCloseTo(300 * (0.45 * 1.55) ** 2, 6);
  });
});
