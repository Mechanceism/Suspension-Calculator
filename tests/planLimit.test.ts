import { describe, expect, it } from 'vitest';
import { runTest } from '../src/core';
import type { AppState } from '../src/app/store';
import { defaultDesign } from '../src/app/store';
import { carProfileDesign } from '../src/app/carProfiles';
import { buildVehicleProblem } from '../src/app/optimizer';
import type { SegmentSpec } from '../src/core/tests/segments';
import { lateralMu, type PlanCar } from '../src/core/tests/plan';

// Round 4 (F4): the planner reads the car's grip at the push it plans to, so a turn planned at 95 % is driven at
// 95 % of the harder-working axle's grip (it was read at 60 % of the static grip, where geometry hardly shows).
describe('speeds as maximums: the grip is read at the planned push', () => {
  const seg = (o: Partial<SegmentSpec>): SegmentSpec => ({ distance: 100, v0: 40, v1: 40, path: 'straight', radius: 0, grade: 0, bank: 0, ...o });
  for (const [name, design] of [['default car', defaultDesign()], ['kart', carProfileDesign('kart')]] as const) {
    it(`${name}: a steady turn planned at 95 % uses ≈ 95 % of the grip`, () => {
      const p = buildVehicleProblem(design as unknown as AppState).problem;
      const geoms = Object.fromEntries(Object.entries(p.designs).map(([r, d]) => [r, d!.geometry]));
      const segs = [seg({ distance: 150 }), seg({ distance: 80, path: 'left', radius: name === 'kart' ? 20 : 30 })];
      const run = runTest(p, geoms, segs, { onFail: 'report', plan: { gripTarget: 0.95, ladder: false } });
      const inTurn = run.states.filter((s) => s.state.segment === 1 && Math.abs(s.state.ax) < 0.02);
      expect(inTurn.length).toBeGreaterThan(0);
      for (const s of inTurn) expect(s.grip!.maxUtilization).toBeCloseTo(0.95, 1);
    }, 120000);
  }

  it('the side grip by turn radius: between the measured turns by curvature, the nearest beyond them', () => {
    const car = { muFront: 1, muRear: 0.9, lateralAt: [{ radius: 10, front: 1, rear: 0.6 }, { radius: 40, front: 1, rear: 0.9 }] } as PlanCar;
    expect(lateralMu(car, 0)).toEqual({ front: 1, rear: 0.9 }); // straight
    expect(lateralMu(car, 1 / 5).rear).toBeCloseTo(0.6, 9); // tighter than measured
    expect(lateralMu(car, -1 / 80).rear).toBeCloseTo(0.9, 9); // wider (either way)
    // 1/R halfway between 1/10 and 1/40 → halfway between the grips.
    expect(lateralMu(car, (1 / 10 + 1 / 40) / 2).rear).toBeCloseTo(0.75, 9);
  });
});
