import { describe, expect, it } from 'vitest';
import { useApp, defaultDesign, mergedCorners, layoutOf, POINT_KEYS } from '../src/app/store';
import { withUseCase } from '../src/app/useCases';
import { buildVehicleProblem, designRoots, vehVarKey } from '../src/app/optimizer';
import { pointAxisLocked } from '../src/app/locks';
import { vehicleObjective } from '../src/core/optimize/vehicle';

// Round 5: the optimizer's result didn't repeat (each pool worker warm-started its solves from the last point *it*
// evaluated). Now every evaluation warm-starts from the start: a point's residuals don't depend on what came before.
describe('repeatable optimizer evaluations', () => {
it('a point gives the same residuals whatever was evaluated before it', () => {
  const d0 = defaultDesign();
  useApp.getState().applyDesign({ ...d0, ...withUseCase(d0, 'track') } as never, null, null);
  const s = useApp.getState();
  const all = mergedCorners(s);
  const f = (x: number) => ({ text: String(x), value: x });
  s.updateVehicleOptimizer((o) => {
    const ranges = { ...o.ranges };
    for (const { root } of designRoots(s)) {
      const g = all[root].geom;
      for (const k of POINT_KEYS) for (const a of [0, 1, 2] as const) {
        if (pointAxisLocked(s.locks, root, k, a, g.damperArm, g.kind, layoutOf(g), g.steerMechanism, g.steeredAxle)) continue;
        const v = g.points[k][a].value;
        ranges[vehVarKey(root, k, a)] = { lo: f(v - 25), hi: f(v + 25) };
      }
    }
    return { ...o, ranges, goals: { ...o.goals, testPass: { ...o.goals.testPass, on: true }, testReserve: { ...o.goals.testReserve, on: true } } };
  });
  const t = useApp.getState().tests.find((x) => x.name === 'Autocross (simple)')!;
  const p = buildVehicleProblem(useApp.getState(), { caseSource: t.id }).problem;
  expect(p.variables.length).toBeGreaterThan(20);
  const o1 = vehicleObjective(p), o2 = vehicleObjective(p);
  const x = o1.x0.map((v, i) => v + (i % 3 === 0 ? 2 : -1));
  const far = o1.x0.map((v, i) => v + (i % 2 === 0 ? 20 : -20));
  const a = o1.residuals(x)!;
  o2.residuals(far);
  const b = o2.residuals(x)!;
  expect(b).toEqual(a);
}, 300000);
});
