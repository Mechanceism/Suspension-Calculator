import { describe, it, expect } from 'vitest';
import { assembleVehicle, solveCase, rideRun, damperForce, type VehicleProblem, type TireForceModel, type SegmentSpec } from '../src/core';
import { defaultDesign } from '../src/app/store';
import { serializeProject, importProject } from '../src/app/project';
import { damperOf } from '../src/app/optimizer';
import { SAMPLE_LAYOUTS, SAMPLE_SPRING } from '../src/examples/sampleLayouts';

const geom = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
const profile = { radius: 260, width: 205, shoulderRadius: 25, rimRadius: 165 };
const gas: TireForceModel = { kind: 'gas', volumeChange: true, volumeFactor: 1, conditions: { setPressure: 83, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 } };
const des = (bump = 1500, rebound = 2500) => ({ geometry: geom, profile, model: gas, springRate: SAMPLE_SPRING.rate, freeLength: SAMPLE_SPRING.freeLength, unsprungMass: 12, damping: { bump, rebound } });
const base = (over: Partial<VehicleProblem> = {}, d = des()): VehicleProblem => ({
  designs: { FL: d }, roots: { FL: 'FL', FR: 'FL', RL: 'FL', RR: 'FL' },
  settings: { FL: { brake: 'outboard', drive: 'none' }, FR: { brake: 'outboard', drive: 'none' }, RL: { brake: 'outboard', drive: 'chassis' }, RR: { brake: 'outboard', drive: 'chassis' } },
  mass: 300, cg: { x: 0, height: 280, z: -0.47 * 1550 }, wheelbase: 1550, brakeBias: 0.6, driveSplit: 0.5, autoPreload: true,
  shared: { front: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } }, rear: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } } },
  dropLinks: { front: null, rear: null }, droop: 50, bump: 50, cases: { lateralG: 0, brakingG: 0, accelG: 0 }, goals: [], variables: [],
  ride: { rollInertia: 35, pitchInertia: 100, tireDamping: 100 },
  ...over,
});
const straight = (d: number, v = 15): SegmentSpec => ({ distance: d, v0: v, v1: v, path: 'straight', radius: 0, grade: 0, bank: 0 });

describe('ride over time (Phase B)', () => {
  it('on a smooth straight at constant speed the car stays at its steady state', () => {
    const r = rideRun(base(), { FL: geom }, [straight(30)]);
    expect(r.error).toBeUndefined();
    const f0 = r.frames[0]!, fN = r.frames.at(-1)!;
    for (const id of ['FL', 'FR', 'RL', 'RR'] as const) expect(Math.abs(fN.ride!.travel[id] - f0.ride!.travel[id])).toBeLessThan(0.05);
    expect(Math.abs(fN.ride!.pose.roll)).toBeLessThan(1e-4);
  });

  it('turning in, the body rolls and settles at the steady roll for that cornering', () => {
    const p = base();
    const turn: SegmentSpec = { distance: 60, v0: 12, v1: 12, path: 'left', radius: 25, grade: 0, bank: 0 };
    const r = rideRun(p, { FL: geom }, [straight(15, 12), turn]);
    const g = (12 * 12) / (9.80665 * 25);
    const asm = assembleVehicle(p, { FL: geom })!;
    const steady = solveCase(p, asm, { name: 's', kind: 'state', g, lateralG: g, brakingG: 0, accelG: 0 })!.result;
    const last = r.frames.at(-1)!;
    expect(last.ride!.pose.roll).toBeCloseTo(steady.pose.roll, 3);
    expect(last.ride!.travel.FR).toBeCloseTo(steady.corners.FR.travel, 0);
    // It got there through motion: the roll rate was not zero during the turn-in.
    const rolls = r.frames.filter((f) => f.segment === 1).map((f) => f.ride!.pose.roll);
    expect(Math.max(...rolls.map(Math.abs))).toBeGreaterThan(Math.abs(steady.pose.roll) * 0.9);
  });

  it('a bump makes the wheel move and the motion dies out; more damping settles it faster', () => {
    const bumpRoad = (d: number): SegmentSpec => ({ ...straight(d), road: { rough: null, features: [{ kind: 'bump', at: 5, length: 0.6, height: 30, side: 'both' }] } });
    const run = (c: number) => rideRun(base({}, des(c, c * 1.6)), { FL: geom }, [bumpRoad(25)], { hz: 200 });
    const soft = run(400), firm = run(3000);
    const travel = (r: ReturnType<typeof rideRun>) => r.frames.map((f) => f.ride!.travel.FL);
    const peak = Math.max(...travel(soft));
    expect(peak).toBeGreaterThan(travel(soft)[0]! + 5);
    // Late in the run (after the rear wheels crossed too) the firm car has settled more.
    const late = (r: ReturnType<typeof rideRun>) => {
      const fs = r.frames.filter((f) => f.t > 1.0);
      const xs = fs.map((f) => f.ride!.pose.heave);
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(late(firm)).toBeLessThan(late(soft));
  });

  it('runs fast enough: 10 s of driving in a few seconds', () => {
    const t0 = performance.now();
    rideRun(base(), { FL: geom }, [{ ...straight(150), road: { rough: { seed: 3, maxHeight: 20, scale: 1.5, coverage: 0.7 }, features: [] } }]);
    expect(performance.now() - t0).toBeLessThan(8000);
  });

  it('two-stage dampers: low-speed rate up to the knee, high-speed rate past it; linear when the rates match', () => {
    const d = { bump: 1500, rebound: 2500, bumpHigh: 750, reboundHigh: 1250, bumpKnee: 0.1, reboundKnee: 0.1 };
    expect(damperForce(d, 0.05)).toBeCloseTo(125, 9);
    expect(damperForce(d, 0.3)).toBeCloseTo(2500 * 0.1 + 1250 * 0.2, 9);
    expect(damperForce(d, -0.3)).toBeCloseTo(-(1500 * 0.1 + 750 * 0.2), 9);
    expect(damperForce({ bump: 1500, rebound: 2500 }, -0.3)).toBeCloseTo(-450, 9);
    // A digressive damper eases the hit of a sharp bump at speed.
    const sharp: SegmentSpec = { ...straight(20, 20), road: { rough: null, features: [{ kind: 'bump', at: 5, length: 0.3, height: 25, side: 'both' }] } };
    const peak = (dd: typeof d | { bump: number; rebound: number }) => Math.max(...rideRun(base({}, { ...des(), damping: dd }), { FL: geom }, [sharp], { hz: 400 }).frames.map((f) => f.ride!.tireLoad.FL));
    expect(peak(d)).toBeLessThan(peak({ bump: 1500, rebound: 2500 }));
  });

  it('the damper mode and two-stage inputs save with the project; older files stay linear', () => {
    const d = defaultDesign();
    d.damperMode = 'twoStage';
    const back = importProject(JSON.parse(JSON.stringify(serializeProject(d, 'D')))).design;
    expect(back.damperMode).toBe('twoStage');
    expect(damperOf(back)).toEqual({ bump: 1500, rebound: 2500, bumpHigh: 750, reboundHigh: 1250, bumpKnee: 0.1, reboundKnee: 0.1 });
    expect(damperOf(defaultDesign())).toEqual({ bump: 1500, rebound: 2500 });
  });

  it('tuning springs and dampers on the ride (Bayesian optimization) improves on dampers that are far too soft', async () => {
    const { tuneRates, scoreTests } = await import('../src/core');
    const p = base({}, des(150, 250));
    const bumpy: SegmentSpec = { ...straight(12, 15), road: { rough: { seed: 4, maxHeight: 25, scale: 1.2, coverage: 0.8 }, features: [] } };
    const tests = [{ segments: [bumpy], weight: 1, onFail: 'report' as const }];
    const vars = [
      { kind: 'bump' as const, root: 'FL' as const, lo: 100, hi: 6000, value: 150, label: 'bump' },
      { kind: 'rebound' as const, root: 'FL' as const, lo: 100, hi: 8000, value: 250, label: 'rebound' },
    ];
    const r = tuneRates(p, tests, vars, { budget: 7, seed: 3 });
    expect(r.evaluations).toBe(7);
    expect(r.after).toBeLessThan(r.before * 0.9);
    // Stiffer damping than the soft start was found.
    expect(r.x[0]! + r.x[1]!).toBeGreaterThan(400);
    expect(scoreTests(p, tests).score).toBeCloseTo(r.before, 6);
  }, 400_000);
});
