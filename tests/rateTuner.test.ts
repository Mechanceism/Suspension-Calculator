import { describe, expect, it, vi } from 'vitest';
import type { TestRun } from '../src/core/tests/run';
import type { VehicleProblem } from '../src/core/optimize/vehicle';

// Round 4: the springs and dampers tuner plans once (no ladder, for speed); its runs now start from where the
// last run's ladder left each segment, so its scores match the optimize loop's — and its rates are kept only
// when the tests as driven (with the ladder) get better.
vi.mock('../src/app/optimizer', async (orig) => {
  const m = await orig<typeof import('../src/app/optimizer')>();
  return {
    ...m,
    // The tuner proposes the springs × `factor` (set by the test) and says that's better on its own score.
    runRatesJob: (_p: VehicleProblem, _tests: unknown, vars: { value: number; kind: string }[]) => ({
      stop() {},
      done: Promise.resolve({ x: vars.map((v) => (v.kind === 'spring' ? v.value * factor.k : v.value)), before: 10, after: 5, evaluations: 2, history: [10, 5], stopped: false }),
    }),
    // The test: a stiffer spring is slower (10 s at 60 N/mm, + 0.01 s per N/mm).
    runTestJob: (p: VehicleProblem) => ({
      cancel() {},
      done: Promise.resolve((): TestRun => {
        const k = Object.values(p.designs)[0]!.springRate;
        return { severity: 'pass', passed: true, states: [], time: 10 + 0.01 * (k - 60), distance: 100, segments: [{ index: 0, severity: 'pass', passed: true, maxUtilization: 0.9, impossible: false, steer: null, findings: [] }] };
      }).then((f) => f()),
    }),
  };
});
const factor = { k: 2 };

describe('the springs and dampers tuner', () => {
  it('a run without the ladder, started from a run\'s ladder choices, drives and scores as that run', async () => {
    const { runTest, planStartOf } = await import('../src/core/tests/run');
    const { testScore } = await import('../src/core/tests/score');
    const { defaultDesign } = await import('../src/app/store');
    const { buildVehicleProblem } = await import('../src/app/optimizer');
    const { TEST_PRESETS, segmentSpec, planOption, driverSpeedOf } = await import('../src/app/tests');
    const p = buildVehicleProblem(defaultDesign() as never).problem;
    const geoms = Object.fromEntries(Object.entries(p.designs).map(([r, d]) => [r, d!.geometry]));
    const t = { ...TEST_PRESETS.find((x) => x.label.startsWith('Autocross (simple)'))!.make(), id: 'a' };
    const specs = t.segments.map((s) => segmentSpec(s, t as never));
    const opts = { onFail: 'report' as const, ride: true, handling: true, driverSpeed: driverSpeedOf(t as never) };
    const po = planOption(t as never);
    const full = runTest(p, geoms, specs, { ...opts, ...po });
    // The ladder lowered some segment's push (the hairpin), else this check means nothing.
    expect(full.segments.some((s) => (s.gripTarget ?? 1) < 0.95 - 1e-9)).toBe(true);
    const once = runTest(p, geoms, specs, { ...opts, plan: { ...po.plan!, ladder: false } });
    const started = runTest(p, geoms, specs, { ...opts, plan: { ...po.plan!, ladder: false, start: planStartOf(full) } });
    const score = (r: TestRun) => testScore(r, 'improve', { weight: 1, ref: full.time });
    // Planned once from the full push it fails where the ladder slowed it; from the ladder's choices it matches.
    expect(score(once)).toBeGreaterThan(score(full) + 50);
    expect(started.segments.map((s) => [s.approach, s.gripTarget])).toEqual(full.segments.map((s) => [s.approach, s.gripTarget]));
    expect(started.time).toBeCloseTo(full.time!, 6);
    expect(score(started)).toBeCloseTo(score(full), 6);
  }, 240000);

  it('rates that make the tests as driven worse are put back; better ones kept', async () => {
    (globalThis as unknown as { confirm: () => boolean }).confirm = () => true;
    (globalThis as unknown as { window: unknown }).window = Object.assign(globalThis, { location: { search: '' } });
    const { useApp, defaultDesign } = await import('../src/app/store');
    const { withUseCase } = await import('../src/app/useCases');
    const { tuneSpringsDampers, useLoop, setRateSettings } = await import('../src/app/testOptimize');
    const { runTestsTogether, useRun } = await import('../src/app/panels/TestsPanels');
    const d0 = defaultDesign();
    useApp.getState().applyDesign({ ...d0, ...withUseCase(d0, 'track') } as never, null, null);
    setRateSettings({ springs: true, dampers: false, bars: false });
    const active = useApp.getState().tests.find((t) => t.name === 'Autocross (simple)')!;
    const spring = () => useApp.getState().spring.springRate.value;
    const k0 = spring();
    expect(k0).toBeCloseTo(60, 6);
    await runTestsTogether([active]);
    expect(useRun.getState().results[active.id]!.result.time).toBeCloseTo(10, 9);
    // Stiffer: its own score says better, the tests as driven say slower → put back, with the results.
    factor.k = 2;
    const r1 = await tuneSpringsDampers('test', active, 'improve');
    expect(r1?.improved).toBe(false);
    expect(spring()).toBeCloseTo(k0, 6);
    expect(useLoop.getState().log.some((l) => /worse on the tests as driven.*put back/.test(l))).toBe(true);
    expect(useRun.getState().results[active.id]!.result.time).toBeCloseTo(10, 9);
    // Softer: faster as driven → kept.
    factor.k = 0.5;
    const r2 = await tuneSpringsDampers('test', active, 'improve');
    expect(r2?.improved).toBe(true);
    expect(spring()).toBeCloseTo(k0 / 2, 1);
    expect(useRun.getState().results[active.id]!.result.time).toBeLessThan(10);
  }, 120000);
});
