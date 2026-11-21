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
    expect(b.problem.states).toHaveLength(testStates(t.segments.map(segmentSpec)).length);
    expect(b.problem.diff?.rear).toBe('lsd');
    expect(b.problem.settings.RL.abs).toBe(false);
  });
});
