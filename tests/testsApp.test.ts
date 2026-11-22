import { describe, it, expect } from 'vitest';
import { defaultDesign, type AppState } from '../src/app/store';
import { serializeProject, importProject } from '../src/app/project';
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
    const t = { ...TEST_PRESETS[2]!.make(), id: newTestId('test') }; // hills: features + rough
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
    const a = { ...TEST_PRESETS[3]!.make(), id: 'a', rank: 1 };
    const b = { ...TEST_PRESETS[3]!.make(), id: 'b', rank: 2 };
    const st = statesForTests([a, b], 'all');
    const wa = st.filter((s) => s.name.startsWith(a.name) && st.indexOf(s) < st.length / 2).reduce((x, s) => x + (s.weight ?? 0), 0);
    const wb = st.slice(st.length / 2).reduce((x, s) => x + (s.weight ?? 0), 0);
    expect(wa / wb).toBeCloseTo(2, 6);
  });

  it('older files: priority % and segment weights become ranks (largest = P1)', () => {
    const d = defaultDesign();
    const t1 = { ...TEST_PRESETS[0]!.make(), id: 't1' };
    const t2 = { ...TEST_PRESETS[3]!.make(), id: 't2' };
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

  it('metric shows km/h, imperial mph', async () => {
    const { PRESETS } = await import('../src/app/units');
    expect(PRESETS.metric.speed).toBe('km/h');
    expect(PRESETS.imperial.speed).toBe('mph');
  });
});
