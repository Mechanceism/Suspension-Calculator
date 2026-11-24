import { describe, it, expect } from 'vitest';
import { lockedAxleForces, runTest } from '../src/core';
import type { AppState } from '../src/app/store';
import { defaultDesign } from '../src/app/store';
import { carProfileDesign } from '../src/app/carProfiles';
import { buildVehicleProblem } from '../src/app/optimizer';
import { TEST_PRESETS, segmentSpec } from '../src/app/tests';
import { rideRun } from '../src/core/tests/ride';

describe('a locked axle (no differential)', () => {
  it('straight: equal shares; turning: the outside wheel is dragged back, the inside one pushes (against the yaw)', () => {
    const [l0, r0] = lockedAxleForces(1000, 15, 0.0, [0.6, 0.6], [800, 800], null);
    expect(l0).toBeCloseTo(500, 6);
    expect(r0).toBeCloseTo(500, 6);
    // Turning left (yaw > 0): the left (inside) wheel's ground is slower, so it pushes more.
    const [l, r] = lockedAxleForces(1000, 15, 0.6, [0.6, 0.6], [600, 1000], null);
    expect(l + r).toBeCloseTo(1000, 6);
    expect(l).toBeGreaterThan(r);
    // Yaw moment of the pair, Σ −y · Fx (left at +y): against the left turn.
    expect(-0.6 * l + 0.6 * r).toBeLessThan(0);
    // Coasting: one wheel drives, the other brakes.
    const [lc, rc] = lockedAxleForces(0, 15, 0.6, [0.6, 0.6], [800, 800], null);
    expect(lc).toBeGreaterThan(0);
    expect(rc).toBeLessThan(0);
    // Capped at the tires' grip.
    const [lk] = lockedAxleForces(0, 15, 3, [0.6, 0.6], [800, 800], [900, 900]);
    expect(lk).toBeLessThanOrEqual(900);
  });

  it('the kart on Autocross (complex) no longer spins (it used to: a locked axle split by load pushed it into the turn)', () => {
    const p = buildVehicleProblem(carProfileDesign('kart') as unknown as AppState).problem;
    const t = { ...TEST_PRESETS.find((x) => x.label.startsWith('Autocross (complex)'))!.make(), id: 'x' };
    const geoms = Object.fromEntries(Object.entries(p.designs).map(([r, d]) => [r, d!.geometry]));
    const r = rideRun(p, geoms, t.segments.map((s) => segmentSpec(s, t as never)), { handling: true });
    expect(r.metrics.maxSideslip!).toBeLessThan(10);
    expect(r.findings.flat().some((f) => f.check === 'spin')).toBe(false);
  });
});

describe('driver lifts', () => {
  it('over time the lifted segments are driven at the speed that passes', () => {
    const p = buildVehicleProblem(defaultDesign() as unknown as AppState).problem;
    const geoms = Object.fromEntries(Object.entries(p.designs).map(([r, d]) => [r, d!.geometry]));
    // A turn too fast for the tires.
    const seg = { distance: 60, v0: 28, v1: 28, path: 'left' as const, radius: 25, grade: 0, bank: 0 };
    const report = runTest(p, geoms, [seg], { onFail: 'report', speedLimits: false, ride: true, handling: true });
    const lift = runTest(p, geoms, [seg], { onFail: 'lift', speedLimits: false, ride: true, handling: true });
    const lim = lift.segments[0]!.speedLimit!;
    expect(report.passed).toBe(false);
    expect(lim).toBeGreaterThan(0);
    // A speed scale (× the segment's speed): driven slower, but not crawling, and judged there.
    expect(lim).toBeLessThan(1);
    expect(lim).toBeGreaterThan(0.3);
    const top = Math.max(...lift.ride!.frames.map((f) => f.speed));
    expect(top).toBeLessThanOrEqual(28 * lim + 1e-6);
    expect(top).toBeGreaterThan(28 * lim * 0.8);
    expect(Math.max(...report.ride!.frames.map((f) => f.speed))).toBeGreaterThan(top);
    expect(lift.segments[0]!.passed).toBe(true);
  });
});
