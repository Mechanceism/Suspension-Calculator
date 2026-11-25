import { describe, expect, it } from 'vitest';
import { planSpeeds, type PlanCar } from '../src/core/tests/plan';
import { G, type SegmentSpec } from '../src/core/tests/segments';
import { rideScore } from '../src/core/tests/score';
import { TEST_PRESETS, planOption, topSpeedOf } from '../src/app/tests';
import { defaultDesign } from '../src/app/store';
import { serializeProject, importProject, FORMAT_VERSION } from '../src/app/project';

const car: PlanCar = {
  muFront: 1, muRear: 1, frontShare: 0.5, cgHeight: 500, wheelbase: 2500, track: 1500, brakeBias: 0.65, driveSplit: 0,
  brakesFront: true, brakesRear: true, drivenFront: false, drivenRear: true, mass: 1000,
};
const seg = (o: Partial<SegmentSpec>): SegmentSpec => ({ distance: 100, v0: 10, v1: 10, path: 'straight', radius: 0, grade: 0, bank: 0, ...o });

// Round 4 (F6): grip only — no set-speed caps; the grip limits the turns, braking and accelerating, a top speed the straights.
describe('grip only', () => {
  it('the set speeds are not caps: turns at the grip, straights up to the top speed, the start and the end kept', () => {
    const segs = [seg({ v0: 0, distance: 200 }), seg({ distance: 60, path: 'left', radius: 30 }), seg({ distance: 200 }), seg({ distance: 40, v1: 0 })];
    const capped = planSpeeds(segs, car, [0.95, 0.95, 0.95, 0.95]);
    const free = planSpeeds(segs, car, [0.95, 0.95, 0.95, 0.95], [], { gripOnly: { topSpeed: 30 } });
    for (const pl of capped.plans) for (const v of pl.v) expect(v).toBeLessThanOrEqual(10 + 1e-6);
    // The turn at its grip: √(0.95 μ g R) ≈ 16.7 m/s, above the set 10.
    const vTurn = Math.sqrt(0.95 * G * 30);
    expect(Math.max(...free.plans[1]!.v)).toBeCloseTo(vTurn, 1);
    // A straight reaches the top speed, never above it.
    expect(Math.max(...free.plans[2]!.v)).toBeCloseTo(30, 6);
    for (const pl of free.plans) for (const v of pl.v) expect(v).toBeLessThanOrEqual(30 + 1e-6);
    // It starts at the first segment's start speed and stops at the end; faster than capped.
    expect(free.plans[0]!.v[0]).toBe(0);
    expect(free.plans[3]!.v[free.plans[3]!.v.length - 1]).toBeCloseTo(0, 6);
    expect(free.time).toBeLessThan(capped.time - 5);
  });

  it('the lap presets are grip only; the top speed defaults to the highest set speed; saved and read back (format 44)', () => {
    for (const label of ['Autocross (simple)', 'Autocross (complex)', 'Balanced']) expect(TEST_PRESETS.find((x) => x.label.startsWith(label))!.make().speedMode).toBe('grip');
    expect(TEST_PRESETS.find((x) => x.label.startsWith('Pothole'))!.make().speedMode).toBe('max');
    const t = { ...TEST_PRESETS.find((x) => x.label.startsWith('Balanced'))!.make(), id: 'b' };
    const high = Math.max(...t.segments.map((s) => Math.max(s.speedStart.value, s.speedEnd.value)));
    expect(topSpeedOf(t)).toBe(high);
    expect(planOption(t).plan).toEqual({ gripTarget: 0.95, gripOnly: { topSpeed: high } });
    const own = { ...t, topSpeed: { text: '40', value: 40 } };
    expect(planOption(own, false).plan).toEqual({ gripTarget: 0.95, ladder: false, gripOnly: { topSpeed: 40 } });
    const d = defaultDesign();
    d.tests = [own];
    const file = JSON.parse(JSON.stringify(serializeProject(d, 'G')));
    expect(file.formatVersion).toBe(FORMAT_VERSION);
    expect(FORMAT_VERSION).toBe(44);
    const back = importProject(file).design.tests[0]!;
    expect(back.speedMode).toBe('grip');
    expect(back.topSpeed?.value).toBe(40);
  });

  it('wheel lift is noted, not scored', () => {
    const m = { liftTime: 0, bumpStopTime: 0.1, loadVariation: 0.2, heaveAccRms: 1, maxPathError: 0.3, maxSideslip: 2 } as Parameters<typeof rideScore>[0];
    expect(rideScore({ ...m!, liftTime: 3 })).toBe(rideScore(m));
  });
});
