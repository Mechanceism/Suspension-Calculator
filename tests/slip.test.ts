import { describe, it, expect } from 'vitest';
import {
  shareLateral, assembleVehicle, solveCase, runTest, segmentStates, segmentLongG, segmentLatG, roadEffective,
  type VehicleProblem, type CaseSpec, type SegmentSpec, type TireForceModel,
} from '../src/core';
import { SAMPLE_LAYOUTS, SAMPLE_SPRING } from '../src/examples/sampleLayouts';

const geom = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
const profile = { radius: 260, width: 205, shoulderRadius: 25, rimRadius: 165 };
const gas: TireForceModel = { kind: 'gas', volumeChange: true, volumeFactor: 1, conditions: { setPressure: 83, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 } };
const des = { geometry: geom, profile, model: gas, springRate: SAMPLE_SPRING.rate, freeLength: SAMPLE_SPRING.freeLength, unsprungMass: 12 };
const MPH = 0.44704;

const base = (over: Partial<VehicleProblem> = {}): VehicleProblem => ({
  designs: { FL: des }, roots: { FL: 'FL', FR: 'FL', RL: 'FL', RR: 'FL' },
  settings: { FL: { brake: 'outboard', drive: 'none' }, FR: { brake: 'outboard', drive: 'none' }, RL: { brake: 'outboard', drive: 'chassis' }, RR: { brake: 'outboard', drive: 'chassis' } },
  mass: 300, cg: { x: 0, height: 280, z: -0.47 * 1550 }, wheelbase: 1550, brakeBias: 0.6, driveSplit: 0.5, autoPreload: true,
  shared: { front: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } }, rear: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } } },
  dropLinks: { front: null, rear: null }, droop: 50, bump: 50, cases: { lateralG: 0, brakingG: 0, accelG: 0 }, goals: [], variables: [],
  ...over,
});
const solve = (p: VehicleProblem, c: Partial<CaseSpec>) => {
  const asm = assembleVehicle(p, { FL: geom })!;
  return solveCase(p, asm, { name: 'x', kind: 'state', g: 0, lateralG: 0, brakingG: 0, accelG: 0, ...c })!.result;
};

describe('tire force sharing', () => {
  it('within an axle, both tires use the same share of their grip', () => {
    const r = shareLateral(900, [0, 0], [1000, 500]);
    expect(r.fy[0]).toBeCloseTo(600, 3);
    expect(r.fy[1]).toBeCloseTo(300, 3);
    expect(r.u).toBeCloseTo(0.6, 6);
    // A tire already braking hard has less left for cornering.
    const b = shareLateral(900, [800, 0], [1000, 1000]);
    expect(b.fy[0]).toBeLessThan(b.fy[1]!);
  });

  it('front/rear cornering shares follow the CG position (yaw balance)', () => {
    const r = solve(base(), { lateralG: 0.5 });
    const front = r.corners.FL.lateralForce + r.corners.FR.lateralForce;
    const total = front + r.corners.RL.lateralForce + r.corners.RR.lateralForce;
    expect(front / total).toBeCloseTo((1550 - 0.47 * 1550) / 1550, 6);
  });
});

describe('road: grade and bumps', () => {
  it('uphill at constant speed needs drive force m·g·sin(grade) and moves load rearward', () => {
    const grade = Math.atan(0.1);
    const e = roadEffective(0, 0, grade, 0);
    expect(e.accelG).toBeCloseTo(Math.sin(grade), 9);
    const flat = solve(base(), {});
    const up = solve(base(), { accelG: e.accelG, gravityScale: e.gravityScale });
    const drive = up.corners.RL.driveForce + up.corners.RR.driveForce;
    expect(drive).toBeCloseTo(300 * 9.80665 * Math.sin(grade), 0);
    expect(up.corners.RL.tireLoad).toBeGreaterThan(flat.corners.RL.tireLoad);
  });

  it('a bump under one wheel loads that corner', () => {
    const flat = solve(base(), {});
    const bump = solve(base(), { groundOffset: { FL: 30 } });
    expect(bump.corners.FL.tireLoad).toBeGreaterThan(flat.corners.FL.tireLoad + 100);
    expect(bump.corners.FL.travel).toBeGreaterThan(flat.corners.FL.travel + 3); // the body also lifts and tilts onto the bump
    expect(bump.pose.heave).toBeGreaterThan(flat.pose.heave);
  });
});

describe('grip and slip', () => {
  it('moderate cornering passes; too much runs out of grip on an axle', () => {
    expect(solve(base(), { lateralG: 0.5 }).grip!.passed).toBe(true);
    const hard = solve(base(), { lateralG: 1.6 }).grip!;
    expect(hard.passed).toBe(false);
    expect(hard.limits.some((l) => l.kind === 'understeer' || l.kind === 'oversteer')).toBe(true);
  });

  it('braking past the grip: ABS holds peak force, no ABS locks and slides', () => {
    const withAbs = solve(base(), { brakingG: 1.5 }).grip!;
    expect(Object.values(withAbs.corners).some((c) => c.state === 'abs-limit')).toBe(true);
    const noAbs = base();
    for (const id of ['FL', 'FR', 'RL', 'RR'] as const) noAbs.settings[id] = { ...noAbs.settings[id], abs: false };
    const locked = solve(noAbs, { brakingG: 1.5 }).grip!;
    expect(Object.values(locked.corners).some((c) => c.state === 'locked')).toBe(true);
    expect(locked.limits.some((l) => l.kind === 'lock-up')).toBe(true);
  });

  it('open diff: the unloaded inside rear spins first; a locked diff sends the force to the loaded wheel', () => {
    const open = solve(base(), { lateralG: 0.9, accelG: 0.45 }).grip!;
    const locked = solve(base({ diff: { rear: 'locked' } }), { lateralG: 0.9, accelG: 0.45 }).grip!;
    // Left turn: the left (inside) rear is lighter.
    expect(open.corners.RL.utilization).toBeGreaterThan(open.corners.RR.utilization);
    expect(locked.corners.RL.utilization).toBeLessThan(open.corners.RL.utilization);
  });
});

describe('test segments', () => {
  it('speed change over distance and radius give the accelerations', () => {
    const accel: SegmentSpec = { distance: 100, v0: 0, v1: 60 * MPH, path: 'straight', radius: 0, grade: 0, bank: 0 };
    expect(segmentLongG(accel)).toBeCloseTo((60 * MPH) ** 2 / 200 / 9.80665, 9);
    const turn: SegmentSpec = { distance: 50, v0: 30 * MPH, v1: 30 * MPH, path: 'right', radius: 20, grade: 0, bank: 0 };
    expect(segmentLatG(turn, 30 * MPH)).toBeCloseTo(-((30 * MPH) ** 2) / (9.80665 * 20), 9);
    expect(segmentStates(turn, 0)).toHaveLength(1);
    expect(segmentStates(accel, 0)).toHaveLength(3);
    // Overrides win.
    expect(segmentLatG({ ...turn, latG: 0.7 }, 30 * MPH)).toBe(-0.7);
  });

  it('runs a chain; a too-fast turn fails and gets a speed limit that passes', () => {
    const segs: SegmentSpec[] = [
      { distance: 60, v0: 0, v1: 30 * MPH, path: 'straight', radius: 0, grade: 0, bank: 0 },
      { distance: 40, v0: 40 * MPH, v1: 40 * MPH, path: 'left', radius: 15, grade: 0, bank: 0 },
      { distance: 30, v0: 30 * MPH, v1: 0, path: 'straight', radius: 0, grade: 0, bank: 0 },
    ];
    const run = runTest(base(), { FL: geom }, segs, { margin: 0.1, onFail: 'lift' });
    expect(run.segments[0]!.passed).toBe(true);
    expect(run.segments[1]!.passed).toBe(false);
    expect(run.segments[1]!.reasons.length).toBeGreaterThan(0);
    const k = run.segments[1]!.speedLimit!;
    expect(k).toBeGreaterThan(0.3);
    expect(k).toBeLessThan(1);
    expect(run.segments[1]!.lifted!.every((s) => s.passed)).toBe(true);
  });
});
