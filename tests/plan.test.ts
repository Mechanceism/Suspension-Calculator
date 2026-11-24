import { describe, expect, it } from 'vitest';
import { combinedLimit, longLimits, planAt, planAtTime, planDuration, planSpeeds, type PlanCar } from '../src/core/tests/plan';
import { G, type SegmentSpec } from '../src/core/tests/segments';
import { runTest } from '../src/core';
import type { AppState } from '../src/app/store';
import { defaultDesign } from '../src/app/store';
import { buildVehicleProblem } from '../src/app/optimizer';

const car: PlanCar = {
  muFront: 1, muRear: 1, frontShare: 0.5, cgHeight: 500, wheelbase: 2500, track: 1500, brakeBias: 0.65, driveSplit: 0,
  brakesFront: true, brakesRear: true, drivenFront: false, drivenRear: true, mass: 1000,
};
const seg = (o: Partial<SegmentSpec>): SegmentSpec => ({ distance: 100, v0: 30, v1: 30, path: 'straight', radius: 0, grade: 0, bank: 0, ...o });

describe('speeds as maximums: the planner', () => {
  it('brakes earlier for a turn, never above the set speeds, and accelerates out', () => {
    const segs = [seg({ distance: 150 }), seg({ distance: 40, path: 'left', radius: 25 }), seg({ distance: 100 })];
    const { plans, time } = planSpeeds(segs, car, [0.95, 0.95, 0.95]);
    const vTurn = Math.sqrt(0.95 * 1 * G * 25);
    // In the turn: the cornering speed at 95 % (below the set 30 m/s).
    for (const v of plans[1]!.v) expect(v).toBeLessThanOrEqual(vTurn + 1e-6);
    expect(Math.min(...plans[1]!.v)).toBeGreaterThan(vTurn * 0.99);
    // Braking starts in the straight before it: the straight ends at the turn's speed, starts at the set speed.
    expect(plans[0]!.v[0]).toBeCloseTo(30, 6);
    expect(plans[0]!.v[plans[0]!.v.length - 1]!).toBeCloseTo(plans[1]!.v[0]!, 6);
    // Never above the set speeds; the straight after it accelerates back up.
    for (const pl of plans) for (const v of pl.v) expect(v).toBeLessThanOrEqual(30 + 1e-6);
    expect(plans[2]!.v[plans[2]!.v.length - 1]!).toBeGreaterThan(plans[2]!.v[0]! + 1);
    // Each segment's plan starts where the last one ended; the time adds up.
    expect(plans[1]!.v[0]).toBeCloseTo(plans[0]!.v[plans[0]!.v.length - 1]!, 9);
    expect(time).toBeCloseTo(plans.reduce((a, p) => a + planDuration(p), 0), 9);
  });

  it('a braking segment the brakes cannot make is braked earlier, at the grip target', () => {
    // Rear brakes only: x ≤ t μ r / (1 + t μ h/L).
    const kart: PlanCar = { ...car, brakesFront: false, frontShare: 0.42, cgHeight: 260, wheelbase: 1040 };
    const L = longLimits(kart, 0.95);
    expect(L.brake).toBeCloseTo((0.95 * 0.58) / (1 + 0.95 * 0.25), 6);
    // 22 → 13 m/s in 25 m asks 0.64 g: more than that, so the braking starts in the segment before.
    const segs = [seg({ distance: 80, v0: 22, v1: 22 }), seg({ distance: 25, v0: 22, v1: 13.4 })];
    const { plans } = planSpeeds(segs, kart, [0.95, 0.95]);
    const before = plans[0]!.v;
    expect(before[before.length - 1]!).toBeLessThan(22 - 1);
    for (let k = 1; k < before.length; k++) {
      const a = (before[k]! ** 2 - before[k - 1]! ** 2) / (2 * (plans[0]!.s[k]! - plans[0]!.s[k - 1]!));
      expect(-a).toBeLessThanOrEqual(L.brake * G * 1.0001);
    }
  });

  it('braking while cornering is limited by each axle\u2019s inside wheel', () => {
    const straight = combinedLimit(car, 0.95, 0, 'brake');
    const turning = combinedLimit(car, 0.95, 0.6, 'brake');
    expect(turning).toBeLessThan(straight);
    expect(turning).toBeGreaterThan(0);
    // At the cornering limit nothing is left for braking.
    expect(combinedLimit(car, 0.95, 0.96, 'brake')).toBe(0);
  });

  it('reads a plan by distance and by time', () => {
    const pl = { s: [0, 50, 100], v: [10, 20, 20] };
    expect(planAt(pl, 50).v).toBeCloseTo(20, 9);
    expect(planAt(pl, 25).v).toBeCloseTo(Math.sqrt(100 + (400 - 100) / 2), 9);
    const T = planDuration(pl);
    expect(T).toBeCloseTo(100 / 30 * 1 + 50 / 20, 9);
    const end = planAtTime(pl, T);
    expect(end.s).toBeCloseTo(100, 6);
    expect(planAtTime(pl, 100 / 30).s).toBeCloseTo(50, 6);
  });

  it('a test run with speeds as maximums: planned, timed, and a too-fast turn passes at the speed it can take', () => {
    const p = buildVehicleProblem(defaultDesign() as unknown as AppState).problem;
    const geoms = Object.fromEntries(Object.entries(p.designs).map(([r, d]) => [r, d!.geometry]));
    const segs = [seg({ distance: 120, v0: 28, v1: 28 }), seg({ distance: 60, v0: 28, v1: 28, path: 'left', radius: 25 })];
    const hold = runTest(p, geoms, segs, { onFail: 'report' });
    expect(hold.segments[1]!.passed).toBe(false); // 28 m/s on a 25 m radius is ≈ 3.2 g
    const run = runTest(p, geoms, segs, { onFail: 'report', plan: { gripTarget: 0.95 } });
    expect(run.segments[1]!.passed).toBe(true);
    expect(run.time).toBeGreaterThan(0);
    expect(run.distance).toBeCloseTo(180, 9);
    const pl = run.segments[1]!.plan!;
    expect(Math.max(...pl.v)).toBeLessThan(28);
    // Judged at the planned speed: its states run at the turn's planned speed.
    const states = run.states.filter((st) => st.state.segment === 1);
    expect(Math.max(...states.map((st) => st.state.speed))).toBeLessThan(28);
  }, 120000);
});
