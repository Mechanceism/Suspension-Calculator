import { describe, expect, it } from 'vitest';
import { compareTests, designDifferences } from '../src/app/compare';
import { withDesign } from '../src/app/designOverride';
import { buildVehicleProblem } from '../src/app/optimizer';
import { useApp, defaultDesign } from '../src/app/store';
import { TEST_PRESETS } from '../src/app/tests';
import { serializeProject, importProject } from '../src/app/project';

// R9 compare: both models on both sets of tests; a track both have runs once per model.
describe('compare', () => {
  const preset = (label: string, id: string) => ({ ...TEST_PRESETS.find((x) => x.label.startsWith(label))!.make(), id });

  it('pairs the tests: a track both designs have is one row (whatever its id, name or segment ids)', () => {
    const a1 = preset('Balanced', 'a1'), a2 = preset('Hills', 'a2');
    const b1 = { ...preset('Balanced', 'b1'), name: 'Balanced (old)', segments: preset('Balanced', 'x').segments.map((sg, i) => ({ ...sg, id: `other-${i}` })) };
    const b2 = preset('Oval', 'b2');
    const rows = compareTests([a1, a2], [b1, b2]);
    expect(rows.map((r) => [r.from, r.a?.id, r.b?.id])).toEqual([['both', 'a1', 'b1'], ['A', 'a2', undefined], ['B', undefined, 'b2']]);
    expect(rows[0]!.name).toBe('Balanced / Balanced (old)');
    // A changed track is its own row; unticked tests are left out.
    const changed = { ...b1, segments: b1.segments.map((sg, i) => (i === 0 ? { ...sg, distance: { ...sg.distance, value: 99 } } : sg)) };
    expect(compareTests([a1], [changed]).map((r) => r.from)).toEqual(['A', 'B']);
    expect(compareTests([{ ...a1, enabled: false }], [b1]).map((r) => r.from)).toEqual(['B']);
  });

  it('a snapshot’s own tests, read back from its file, are the same tracks', () => {
    const d = { ...defaultDesign(), tests: [preset('Balanced', 'a1'), preset('Autocross (simple)', 'a2')] };
    const back = importProject(JSON.parse(JSON.stringify(serializeProject(d, 'x')))).design;
    expect(compareTests(d.tests, back.tests).map((r) => r.from)).toEqual(['both', 'both']);
  });

  it('lists the model values that differ (not the tests, file bookkeeping or optimizer setup)', () => {
    const d = defaultDesign();
    const e = { ...d, vehicle: { ...d.vehicle, mass: { text: '380', value: 380 } }, tests: [preset('Balanced', 'z')], fileName: 'other' } as typeof d;
    const diffs = designDifferences(d, e);
    expect(diffs).toEqual([{ path: 'vehicle › mass', a: d.vehicle.mass.text, b: '380' }]);
    expect(designDifferences(d, d)).toEqual([]);
  });

  it('model B is the snapshot’s design with the app as it is otherwise', () => {
    const s = useApp.getState();
    const other = defaultDesign();
    const heavier = { ...other, vehicle: { ...other.vehicle, mass: { ...other.vehicle.mass, value: other.vehicle.mass.value + 200 } } };
    const m = withDesign(s, heavier);
    expect(m.vehicle.mass.value).toBe(other.vehicle.mass.value + 200);
    expect(m.workspace).toBe(s.workspace); // the app's own state kept
    expect(withDesign(s, heavier)).toBe(m); // the same merged state each time (stable for the selectors)
    expect(buildVehicleProblem(m).problem.mass).toBe(other.vehicle.mass.value + 200);
    expect(buildVehicleProblem(s).problem.mass).toBe(s.vehicle.mass.value);
  });
});
