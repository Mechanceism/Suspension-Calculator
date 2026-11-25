import { describe, expect, it } from 'vitest';
import { lostAcceleration, LOST_SPEED_FAIL } from '../src/core/tests/ride';
import { PROFILES } from '../src/core/tests/checks';
import { runTest } from '../src/core';
import type { AppState } from '../src/app/store';
import { defaultDesign } from '../src/app/store';
import { buildVehicleProblem } from '../src/app/optimizer';
import { TEST_PRESETS, segmentSpec, planOption } from '../src/app/tests';
import type { VehicleResult } from '../src/core/vehicle/vehicle';

// Round 4 (F10): over the limit is judged by what it costs — a moment past the grip (a squeal) is noted; it fails
// only when it loses speed in the direction the car is trying to go, or the car runs off the line.
describe('over the limit: judged by what it costs', () => {
  const corner = (fx: number, fy: number, shortfall: number) => ({ longitudinalForce: fx, lateralForce: fy, shortfall });
  const resultOf = (c: Record<string, ReturnType<typeof corner>>) => ({
    corners: Object.fromEntries(Object.entries(c).map(([id, x]) => [id, { longitudinalForce: x.longitudinalForce, lateralForce: x.lateralForce }])),
    grip: { corners: Object.fromEntries(Object.entries(c).map(([id, x]) => [id, { shortfall: x.shortfall }])) },
  }) as unknown as VehicleResult;

  it('only the longitudinal part of what the tires can’t deliver costs speed', () => {
    const ok = corner(0, 0, 0);
    // A front tire sliding sideways at turn-in (no drive or braking): no speed lost.
    expect(lostAcceleration(resultOf({ FL: corner(0, 3000, 300), FR: ok, RL: ok, RR: ok }), 1000)).toBe(0);
    // Wheelspin: 200 N of a purely longitudinal 2000 N can't be delivered → 0.2 m/s².
    expect(lostAcceleration(resultOf({ FL: ok, FR: ok, RL: corner(2000, 0, 200), RR: ok }), 1000)).toBeCloseTo(0.2, 9);
    // Braking in a turn (3-4-5): the shortfall's longitudinal share, 3/5.
    expect(lostAcceleration(resultOf({ FL: corner(-3000, 4000, 500), FR: ok, RL: ok, RR: ok }), 1000)).toBeCloseTo(0.3, 9);
    expect(LOST_SPEED_FAIL * 3.6).toBeCloseTo(1, 9);
    // A slide is a Warning; running off the line still fails.
    expect(PROFILES.default.checks.spin.severity).toBe('warn');
    expect(PROFILES.default.checks.pathError.severity).toBe('fail');
  });

  it('a brief overload at turn-in is noted and the driver keeps the full push (default car, Autocross (simple), grip only)', () => {
    const p = buildVehicleProblem(defaultDesign() as unknown as AppState).problem;
    const geoms = Object.fromEntries(Object.entries(p.designs).map(([r, d]) => [r, d!.geometry]));
    const t0 = TEST_PRESETS.find((x) => x.label.startsWith('Autocross (simple)'))!.make();
    // A 250 % lane: this car leaves the default 200 % one by 1 cm at the hairpin exit (the lane isn't what's tested here).
    const t = { ...t0, id: 'x', checks: { ...t0.checks, pathError: { ...t0.checks.pathError, threshold: 250 } } };
    const specs = t.segments.map((s) => segmentSpec(s, t));
    // As the app drives it (the pedal driver with planned speeds).
    const run = runTest(p, geoms, specs, { onFail: 'report', speedLimits: true, ride: true, handling: true, driverSpeed: true, ...planOption(t) });
    const capped = runTest(p, geoms, specs, { onFail: 'report', speedLimits: true, ride: true, handling: true, ...planOption({ ...t, speedMode: 'max' }) });
    expect(run.passed).toBe(true);
    const squeals = run.segments.flatMap((s) => s.findings).filter((f) => f.check === 'understeer');
    expect(squeals.length).toBeGreaterThan(0);
    for (const f of squeals) { expect(f.severity).toBe('warn'); expect(f.text).toMatch(/noted/); }
    expect(run.segments.flatMap((s) => s.findings).some((f) => f.check === 'gripTarget')).toBe(false);
    expect(run.time!).toBeLessThan(capped.time! - 0.3);
  }, 240000);
});
