import { describe, expect, it } from 'vitest';
import { planSpeeds, type PlanCar } from '../src/core/tests/plan';
import { PLAN_SHAPES } from '../src/core/tests/run';
import type { SegmentSpec } from '../src/core/tests/segments';

const car: PlanCar = {
  muFront: 1, muRear: 1, frontShare: 0.5, cgHeight: 500, wheelbase: 2500, track: 1500, brakeBias: 0.65, driveSplit: 0,
  brakesFront: true, brakesRear: true, drivenFront: false, drivenRear: true, mass: 1000,
};
const seg = (o: Partial<SegmentSpec>): SegmentSpec => ({ distance: 60, v0: 10, v1: 10, path: 'straight', radius: 0, grade: 0, bank: 0, ...o });

// Round 5: from a standstill, braking or coasting in, holding the lowest speed or easing up from it all meant
// staying at 0 — the trophy truck's launch was "held" at 0 km/h and crawled 100 s at the driver's minimum.
describe('a launch is taken only its own way', () => {
  it('from rest every way plans the same speeds as the plan; rolling, they differ', () => {
    const launch = [seg({ v0: 0, v1: 15, distance: 50 }), seg({ path: 'left', radius: 20 })];
    const own = planSpeeds(launch, car, [0.95, 0.95]).plans[0]!;
    for (const sh of PLAN_SHAPES) {
      const p = planSpeeds(launch, car, [0.95, 0.95], [sh, 'plan']).plans[0]!;
      expect(p.v).toEqual(own.v);
      expect(Math.max(...p.v)).toBeGreaterThan(5);
    }
    // A segment entered rolling still has its other ways (holding its speed is slower than the plan here).
    const rolling = [seg({ v0: 8, v1: 15, distance: 50 }), seg({ path: 'left', radius: 20 })];
    const a = planSpeeds(rolling, car, [0.95, 0.95]).plans[0]!;
    const h = planSpeeds(rolling, car, [0.95, 0.95], ['hold', 'plan']).plans[0]!;
    expect(h.v).not.toEqual(a.v);
  });
});
