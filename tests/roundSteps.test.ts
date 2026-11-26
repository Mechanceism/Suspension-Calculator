import { describe, expect, it, vi } from 'vitest';
import type { TestRun } from '../src/core/tests/run';
import type { VehicleProblem } from '../src/core/optimize/vehicle';

// Round 4 (F24): each optimizer round's move is tried at the full step, ½ and ¼ on the tests as driven, and the
// best kept. Here the optimizer always proposes +10 mm on one coordinate, and the lap is fastest 2.5 mm from
// where it started: a quarter of the step.
const probe: { root?: string; point?: string; axis?: number; x0?: number; runs: number } = { runs: 0 };
const valueOf = async (p: VehicleProblem) => {
  const { variableValue } = await import('../src/core/optimize/corner');
  const v = p.variables.find((x) => x.root === probe.root && x.point === probe.point && x.axis === probe.axis) ?? p.variables[0]!;
  return variableValue(p.designs[v.root]!.geometry, v);
};
vi.mock('../src/app/optimizer', async (orig) => {
  const m = await orig<typeof import('../src/app/optimizer')>();
  const { variableValue } = await import('../src/core/optimize/corner');
  // (Points only: the round-5 adjustments — camber, toe, pressure, ride height — stay where they are here.)
  const isPoint = (v: { point: string; root: string }, p: VehicleProblem) => !['staticCamber', 'staticToe', 'tirePressure', 'rideHeight'].includes(v.point) && !!p.designs[v.root as 'FL'];
  return {
    ...m,
    runVehicleOptimizer: (p: VehicleProblem) => ({
      stop() {},
      done: Promise.resolve().then(() => {
        const v0 = p.variables.find((v) => isPoint(v, p))!;
        if (probe.root === undefined) { probe.root = v0.root; probe.point = v0.point; probe.axis = v0.axis; probe.x0 = variableValue(p.designs[v0.root]!.geometry, v0); }
        const variables = p.variables.filter((v) => isPoint(v, p)).map((v) => {
          const b = variableValue(p.designs[v.root]!.geometry, v);
          const first = v.root === probe.root && v.point === probe.point && v.axis === probe.axis;
          return { ...v, before: b, after: b + (first ? 10 : 0), atLimit: false };
        });
        return { result: { geometries: {}, variables, goals: [], status: 'ok', iterations: 1, cost0: 1, cost: 0 }, stopped: false };
      }),
    }),
    runTestJob: (p: VehicleProblem) => ({
      cancel() {},
      done: valueOf(p).then((x): TestRun => {
        probe.runs++;
        const time = 10 + 0.01 * (x - (probe.x0 ?? x) - 2.5) ** 2;
        return { severity: 'pass', passed: true, states: [], time, distance: 100, segments: [{ index: 0, severity: 'pass', passed: true, maxUtilization: 0.9, impossible: false, steer: null, findings: [] }] };
      }),
    }),
  };
});

describe('optimizer rounds: the best of the full step, ½ and ¼ on the driven time (F24)', () => {
  it('keeps a quarter of the step when that is fastest; a round with no better step is undone; one undo step per round', async () => {
    (globalThis as unknown as { confirm: () => boolean }).confirm = () => true;
    (globalThis as unknown as { window: unknown }).window = Object.assign(globalThis, { location: { search: '' } });
    const { useApp, defaultDesign, mergedCorners, rootOf } = await import('../src/app/store');
    const { withUseCase } = await import('../src/app/useCases');
    const { optimizeTests, useLoop, setMaxWiden, setRateSettings, ROUND_STEPS } = await import('../src/app/testOptimize');
    const { useRun } = await import('../src/app/panels/TestsPanels');
    const { pointKeyOf } = await import('../src/app/optimizer');
    expect(ROUND_STEPS).toEqual([1, 0.5, 0.25]);
    const d0 = defaultDesign();
    useApp.getState().applyDesign({ ...d0, ...withUseCase(d0, 'track') } as never, null, null);
    setMaxWiden(1);
    setRateSettings({ withLoop: false });
    const active = useApp.getState().tests.find((t) => t.name === 'Autocross (simple)')!;
    await optimizeTests('test', active, 'improve');
    const log = useLoop.getState().log;
    const now = () => {
      const s = useApp.getState();
      const g = rootOf(s.activeCorner, s.links) === probe.root ? s.geom : mergedCorners(s)[probe.root as 'FL'].geom;
      return g.points[pointKeyOf(probe.point as never)][probe.axis as 0].value;
    };
    // Round 1: three steps tried, the quarter kept (10 + 0 s); round 2: none better, undone.
    expect(log.find((l) => l.startsWith('Round 1:') && l.includes('steps tried'))).toMatch(/with a quarter of the step/);
    expect(log.find((l) => l.startsWith('Round 2:') && l.includes('steps tried'))).toMatch(/no step better.*undone/);
    expect(now()).toBeCloseTo(probe.x0! + 2.5, 2);
    // The results shown are the kept design's (put back, not driven again): 10 s.
    expect(useRun.getState().results[active.id]!.result.time).toBeCloseTo(10, 6);
    // Start, round 1 (3), round 2 (3), the split offer's tries: no extra run to show the kept design.
    expect(probe.runs).toBeLessThanOrEqual(1 + 3 + 3 + 4);
    // Undo takes the design back to where the loop started.
    useApp.getState().undoVehicleOptimized();
    expect(now()).toBeCloseTo(probe.x0!, 2);
  }, 120000);
});
