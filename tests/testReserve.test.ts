import { describe, expect, it } from 'vitest';
import { defaultDesign, type AppState } from '../src/app/store';
import { buildVehicleProblem } from '../src/app/optimizer';
import { TEST_PRESETS } from '../src/app/tests';
import { VEHICLE_GOAL_KINDS, evaluateVehicle, vehicleObjective } from '../src/core/optimize/vehicle';

// Round 4 (F3): the tests optimizer's *Improve* goal (Test reserve) is one residual per test state, the worst
// states counting most — it had fallen into the generic "maximize" goals (one ratio to the start), where a 1 %
// lower grip use weighed less than the keep-close term for a few mm, so each round stalled after a tiny step.
describe('Test reserve goal: per state', () => {
  it('one residual per state: √weight · worst grip use ÷ 5 %', () => {
    const d = defaultDesign();
    const t = { ...TEST_PRESETS.find((x) => x.label.startsWith('Balanced'))!.make(), id: 'b' };
    d.tests = [t];
    const goals = Object.fromEntries(VEHICLE_GOAL_KINDS.map((k) => [k, { ...d.vehicleOptimizer.goals[k], on: k === 'testReserve' }]));
    d.vehicleOptimizer = { ...d.vehicleOptimizer, caseSource: 'b', ranges: {}, goals: goals as typeof d.vehicleOptimizer.goals };
    const p = buildVehicleProblem(d as unknown as AppState).problem;
    expect(p.goals.map((g) => g.kind)).toEqual(['testReserve']);
    const geoms = Object.fromEntries(Object.entries(p.designs).map(([r, x]) => [r, x!.geometry]));
    const e = evaluateVehicle(p, geoms)!;
    expect(e.cases.length).toBeGreaterThan(10);
    const r = vehicleObjective(p).residuals([])!;
    const w = Math.sqrt(p.goals[0]!.weight);
    const want = e.cases.map((c) => (w * Math.sqrt(c.weight) * (c.result.grip?.maxUtilization ?? 1)) / 0.05);
    for (let i = 0; i < want.length; i++) expect(r[i]!).toBeCloseTo(want[i]!, 3); // the solver's tolerance (warm-started)
    // Its cost is far above the old single ratio's ½ · 1², so geometry that lowers grip use is worth moving for.
    expect(0.5 * want.reduce((a, v) => a + v * v, 0)).toBeGreaterThan(50);
  }, 120000);
});
