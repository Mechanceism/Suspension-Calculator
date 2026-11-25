import { describe, it, expect } from 'vitest';
import { defaultDesign, type AppState } from '../src/app/store';
import { serializeProject, importProject, FORMAT_VERSION } from '../src/app/project';
import { TEST_PRESETS, newTestId, segmentSpec, isOff } from '../src/app/tests';
import { buildVehicleProblem } from '../src/app/optimizer';
import { testStates } from '../src/core';

const withTest = () => {
  const d = defaultDesign();
  const t = { ...TEST_PRESETS[0]!.make(), id: newTestId('test') };
  t.segments[2]!.latG = { text: '0.8', value: 0.8 };
  d.tests = [t];
  return { d, t };
};

describe('tests in the app', () => {
  it('save and load with the project, blank overrides stay blank', () => {
    const { d, t } = withTest();
    const r = importProject(JSON.parse(JSON.stringify(serializeProject(d, 'T'))));
    expect(r.warnings).toEqual([]);
    expect(r.design.tests).toHaveLength(1);
    const back = r.design.tests[0]!;
    expect(back.name).toBe(t.name);
    expect(back.segments.map((s) => s.name)).toEqual(t.segments.map((s) => s.name));
    expect(isOff(back.segments[0]!.latG)).toBe(true);
    expect(back.segments[2]!.latG.value).toBe(0.8);
    expect(segmentSpec(back.segments[1]!)).toEqual(segmentSpec(t.segments[1]!));
  });

  it('a test can be the vehicle optimizer\'s load cases; ABS and differential are passed on', () => {
    const { d, t } = withTest();
    d.vehicleOptimizer = { ...d.vehicleOptimizer, caseSource: t.id };
    d.settings = { ...d.settings, RL: { ...d.settings.RL, powered: true, diff: 'lsd', abs: false } };
    const b = buildVehicleProblem(d as AppState);
    expect(b.problem.states).toHaveLength(testStates(t.segments.map((sg) => segmentSpec(sg, t))).length);
    expect(b.problem.diff?.rear).toBe('lsd');
    expect(b.problem.settings.RL.abs).toBe(false);
  });
});

describe('export parts and settings', () => {
  it('model only leaves the tests out; tests only round-trips; snapshots track each part', async () => {
    const { serializeTests, importTests, modelSnapshot, testsSnapshot } = await import('../src/app/project');
    const { d, t } = withTest();
    const modelFile = JSON.parse(JSON.stringify(serializeProject(d, 'M', { tests: false })));
    expect(modelFile.tests).toBeUndefined();
    expect(importProject(modelFile).design.tests).toEqual([]);
    const testsFile = JSON.parse(JSON.stringify(serializeTests(d, 'T')));
    const r = importTests(testsFile);
    expect(r.warnings).toEqual([]);
    expect(r.tests.map((x) => x.name)).toEqual([t.name]);
    // Tests can also be taken from a full project file.
    expect(importTests(JSON.parse(JSON.stringify(serializeProject(d, 'A')))).tests).toHaveLength(1);
    // Changing a test changes only the tests snapshot.
    const m0 = modelSnapshot(d), t0 = testsSnapshot(d);
    const d2 = { ...d, tests: [{ ...t, name: 'Renamed' }] };
    expect(modelSnapshot(d2)).toBe(m0);
    expect(testsSnapshot(d2)).not.toBe(t0);
  });

  it('settings file carries units, view options and custom profiles', async () => {
    const { exportSettingsFile, applySettingsFile } = await import('../src/app/settingsFile');
    const { useUnits } = await import('../src/app/units');
    const { useProfiles } = await import('../src/app/settings');
    const { useApp } = await import('../src/app/store');
    const { PROFILES } = await import('../src/core');
    useUnits.getState().setSystem('imperial');
    useProfiles.getState().saveProfile({ name: 'Mine', checks: PROFILES.drift.checks });
    useApp.getState().set('simpleTire', true);
    const file = JSON.parse(JSON.stringify(exportSettingsFile()));
    useUnits.getState().setSystem('metric');
    useProfiles.getState().setAll([]);
    useApp.getState().set('simpleTire', false);
    expect(applySettingsFile(file)).toEqual([]);
    expect(useUnits.getState().system).toBe('imperial');
    expect(useProfiles.getState().profiles.map((p) => p.name)).toEqual(['Mine']);
    expect(useApp.getState().simpleTire).toBe(true);
  });
});

describe('road surface in tests', () => {
  it('rough surface and features save, load and reach the core; format-8 lumpy becomes rough', async () => {
    const { roadSpecOf } = await import('../src/app/tests');
    const d = defaultDesign();
    const t = { ...TEST_PRESETS[3]!.make(), id: newTestId('test') }; // hills: features + rough
    d.tests = [t];
    const back = importProject(JSON.parse(JSON.stringify(serializeProject(d, 'R')))).design.tests[0]!;
    expect(back.segments[1]!.features.map((f) => f.kind)).toEqual(['bump', 'pothole']);
    expect(back.segments[3]!.rough.on).toBe(true);
    expect(roadSpecOf(back.segments[3]!)).toEqual(roadSpecOf(t.segments[3]!));
    // An old test with lumpy: true and no rough field.
    const old = JSON.parse(JSON.stringify(serializeProject(d, 'R')));
    delete old.tests[0].segments[3].rough;
    old.tests[0].segments[3].lumpy = true;
    expect(importProject(old).design.tests[0]!.segments[3]!.rough.on).toBe(true);
  });
});

describe('priority ranks', () => {
  it('ranks weigh n + 1 − rank; equal ranks weigh the same', async () => {
    const { rankWeight, statesForTests } = await import('../src/app/tests');
    expect(rankWeight(1, 2)).toBe(2);
    expect(rankWeight(2, 2)).toBe(1);
    expect(rankWeight(1, 4)).toBe(rankWeight(1, 4));
    const a = { ...TEST_PRESETS[4]!.make(), id: 'a', rank: 1 };
    const b = { ...TEST_PRESETS[4]!.make(), id: 'b', rank: 2 };
    const st = statesForTests([a, b], 'all');
    const wa = st.filter((s) => s.name.startsWith(a.name) && st.indexOf(s) < st.length / 2).reduce((x, s) => x + (s.weight ?? 0), 0);
    const wb = st.slice(st.length / 2).reduce((x, s) => x + (s.weight ?? 0), 0);
    expect(wa / wb).toBeCloseTo(2, 6);
  });

  it('older files: priority % and segment weights become ranks (largest = P1)', () => {
    const d = defaultDesign();
    const t1 = { ...TEST_PRESETS[0]!.make(), id: 't1' };
    const t2 = { ...TEST_PRESETS[4]!.make(), id: 't2' };
    d.tests = [t1, t2];
    const f = JSON.parse(JSON.stringify(serializeProject(d, 'Old')));
    for (const t of f.tests) delete t.rank;
    f.tests[0].priority = { text: '20', value: 20 };
    f.tests[1].priority = { text: '80', value: 80 };
    f.tests[0].segments.forEach((sg: Record<string, unknown>, i: number) => { delete sg.rank; sg.weight = { text: String(i === 2 ? 3 : 1), value: i === 2 ? 3 : 1 }; });
    const r = importProject(f).design.tests;
    expect(r.map((t) => t.rank)).toEqual([2, 1]);
    expect(r[0]!.segments.map((s) => s.rank)).toEqual([2, 2, 1, 2, 2]);
  });

  it('skipped tests are left out of all-tests optimizing and saved as skipped; segment presets start with Empty', async () => {
    const { statesForTests, SEGMENT_PRESETS } = await import('../src/app/tests');
    const a = { ...TEST_PRESETS[4]!.make(), id: 'a' };
    const b = { ...TEST_PRESETS[4]!.make(), id: 'b', enabled: false };
    const both = statesForTests([a, { ...b, enabled: true }], 'all');
    expect(statesForTests([a, b], 'all')).toHaveLength(both.length / 2);
    // A skipped test can still be optimized on its own.
    expect(statesForTests([a, b], 'b').length).toBeGreaterThan(0);
    const d = defaultDesign();
    d.tests = [a, b];
    const r = importProject(JSON.parse(JSON.stringify(serializeProject(d, 'E')))).design.tests;
    expect(r.map((t) => t.enabled)).toEqual([true, false]);
    const old = JSON.parse(JSON.stringify(serializeProject(d, 'Old')));
    for (const t of old.tests) delete t.enabled;
    expect(importProject(old).design.tests.every((t) => t.enabled)).toBe(true);
    expect(SEGMENT_PRESETS[0]!.label).toBe('Empty');
  });

  it('the vehicle problem carries the steering (steered corners, rack limit)', () => {
    const d = defaultDesign();
    const b = buildVehicleProblem(d as AppState);
    expect(b.problem.steering?.steered).toMatchObject({ FL: true, FR: true, RL: false, RR: false });
    expect(b.problem.steering?.rackLimit).toBe(30);
    const o = buildVehicleProblem({ ...d, tests: [{ ...TEST_PRESETS[4]!.make(), id: 'x' }] } as AppState, { caseSource: 'x' });
    expect(o.problem.states?.length).toBeGreaterThan(0);
  });

  it('every built-in test settles in every state on the default car (warm start falls back to a cold start)', async () => {
    const { runTest } = await import('../src/core');
    const d = defaultDesign();
    const { problem } = buildVehicleProblem(d as AppState);
    const geoms = Object.fromEntries(Object.entries(problem.designs).map(([k, v]) => [k, v!.geometry]));
    for (const preset of TEST_PRESETS) {
      const t = { ...preset.make(), id: 'p' };
      const r = runTest(problem, geoms, t.segments.map((sg) => segmentSpec(sg, t)), { onFail: 'report' });
      expect(r.states.filter((s) => !s.converged).map((s) => `${t.name} ${s.state.name}`)).toEqual([]);
    }
  });

  it('every built-in test also runs over time (Phase B) without going unstable; ride inputs load quietly from older files', async () => {
    const { runTest } = await import('../src/core');
    const d = defaultDesign();
    const { problem } = buildVehicleProblem(d as AppState);
    expect(problem.ride).toEqual({ rollInertia: 35, pitchInertia: 100, yawInertia: 140, tireDamping: 100, relaxation: 0 });
    expect(problem.designs.FL?.damping).toEqual({ bump: 1500, rebound: 2500 });
    const geoms = Object.fromEntries(Object.entries(problem.designs).map(([k, v]) => [k, v!.geometry]));
    for (const preset of TEST_PRESETS) {
      const t = { ...preset.make(), id: 'p' };
      expect(t.ride).toBe(true);
      expect(t.handling).toBe(true);
      const r = runTest(problem, geoms, t.segments.map((sg) => segmentSpec(sg, t)), { onFail: 'report', ride: true, handling: true });
      expect(r.ride?.frames.length).toBeGreaterThan(5);
      expect(r.ride?.frames.every((f) => f.handling && Number.isFinite(f.handling.pathError))).toBe(true);
      expect(r.segments.flatMap((s) => s.findings).filter((f) => f.check === 'noSolution')).toEqual([]);
      // The default car is driven through every preset: it stays on the line and doesn't spin.
      expect(r.segments.flatMap((s) => s.findings).filter((f) => f.check === 'pathError' || f.check === 'spin').map((f) => `${t.name}: ${f.text}`)).toEqual([]);
      expect(r.ride!.metrics!.maxPathError!).toBeLessThan(0.8);
    }
    const old = JSON.parse(JSON.stringify(serializeProject(d, 'Old')));
    old.formatVersion = 9;
    for (const k of ['rollInertia', 'pitchInertia', 'tireDamping']) delete old.vehicle.fields[k];
    const back = importProject(old);
    expect(back.warnings).toEqual(Array.from({ length: FORMAT_VERSION - 9 }, (_, i) => `Upgraded from file format ${i + 9} to ${i + 10}.`));
    expect(back.design.vehicle.rollInertia.value).toBe(35);
  }, 240_000); // about 100 s alone; more when the whole suite runs at once

  it('rate tuning: which rates (locks respected, two-stage high-speed rates), and applying them to the designs', async () => {
    const { useApp } = await import('../src/app/store');
    const { rateVars } = await import('../src/app/testOptimize');
    const d = defaultDesign();
    useApp.setState({ ...d });
    const settings = { springs: true, dampers: true, bars: false, spread: 2, budget: 10, withLoop: true };
    const vars = rateVars(useApp.getState(), settings);
    expect(vars.map((v) => v.kind)).toEqual(['spring', 'bump', 'rebound']);
    expect(vars[0]!.lo).toBeCloseTo(vars[0]!.value / 2, 9);
    useApp.setState({ damperMode: 'twoStage', locks: { 'FL.spring.springRate': true } });
    expect(rateVars(useApp.getState(), settings).map((v) => v.kind)).toEqual(['bump', 'rebound', 'bumpHigh', 'reboundHigh']);
    useApp.getState().applyRateValues([
      { root: 'FL', section: 'damper', key: 'bumpDamping', value: 2100 },
      { axle: 'front', section: 'shared', key: 'arbRate', value: 12.5 },
    ]);
    expect(useApp.getState().damper.bumpDamping.value).toBe(2100);
    expect(useApp.getState().shared.front.arbRate.value).toBe(12.5);
  });

  it('what matters most: a DOE over the free coordinates ranks their effects', async () => {
    const { vehicleSensitivity } = await import('../src/core');
    const d = defaultDesign();
    d.vehicleOptimizer = {
      ...d.vehicleOptimizer,
      ranges: { 'FL.ucaOut.y': { lo: { text: '', value: d.geom.points.ucaOut[1].value - 20 }, hi: { text: '', value: d.geom.points.ucaOut[1].value + 20 } } },
      goals: { ...d.vehicleOptimizer.goals, grip: { ...d.vehicleOptimizer.goals.grip, on: true } },
      lateralG: { text: '0.8', value: 0.8 },
    };
    const { problem } = buildVehicleProblem(d as AppState);
    expect(problem.variables.length).toBeGreaterThan(0);
    const r = vehicleSensitivity({ ...problem, variables: problem.variables.slice(0, 1) }, 8)!;
    expect(r.samples).toBe(8);
    expect(r.cost.effects).toHaveLength(1);
    expect(r.goals[0]!.kind).toBe('grip');
  });

  it('metric shows km/h, imperial mph', async () => {
    const { PRESETS } = await import('../src/app/units');
    expect(PRESETS.metric.speed).toBe('km/h');
    expect(PRESETS.imperial.speed).toBe('mph');
  });
});
