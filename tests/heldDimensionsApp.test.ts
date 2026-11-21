import { describe, it, expect } from 'vitest';
import { useApp, defaultDesign } from '../src/app/store';
import { initHeldDimensions, permanentAllowed } from '../src/app/heldDimensions';
import { buildProblem } from '../src/app/optimizer';
import { serializeProject, importProject } from '../src/app/project';
import type { AppState } from '../src/app/store';

const pos = (k: 'ucaFwd' | 'ucaAft') => useApp.getState().geom.points[k].map((f) => f.value);
const dist = () => { const a = pos('ucaFwd'), b = pos('ucaAft'); return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!); };

describe('held dimensions in the app', () => {
  it('permanent only where the dimension cannot change through travel', () => {
    expect(permanentAllowed('ucaFwd', 'ucaAft', 'front', 'lca').ok).toBe(true); // chassis points
    expect(permanentAllowed('ucaFwd', 'ucaOut', 'distance', 'lca').ok).toBe(true); // same arm
    expect(permanentAllowed('ucaFwd', 'ucaOut', 'front', 'lca').ok).toBe(false); // the arm swings
    expect(permanentAllowed('lcaOut', 'trInner', 'distance', 'lca').ok).toBe(false); // different parts
  });

  it('keeps a held pivot spacing when one pivot is edited: the other follows, the edit stands', () => {
    initHeldDimensions();
    const s = useApp.getState();
    const d0 = dist();
    s.holdDimension({ root: 'FL', a: 'ucaFwd', b: 'ucaAft', measure: 'distance', value: d0, travel: null });
    const z = pos('ucaFwd')[2]!;
    useApp.getState().setPoint('ucaFwd', 2, String(z + 20));
    expect(pos('ucaFwd')[2]).toBe(z + 20);
    expect(dist()).toBeCloseTo(d0, 2);
    expect(useApp.getState().dimViolations).toEqual([]);
  });

  it('reports a held dimension it cannot keep (both points locked)', () => {
    const s = useApp.getState();
    s.setLocks(['FL.part.chassis'], true);
    const x = pos('ucaAft')[0]!;
    s.setLocks(['FL.point.ucaAft.x'], false);
    // Edit while everything involved is locked: the dimension can't be restored.
    useApp.setState({ geom: { ...useApp.getState().geom, points: { ...useApp.getState().geom.points, ucaAft: [{ text: String(x + 30), value: x + 30 }, ...useApp.getState().geom.points.ucaAft.slice(1)] as never } } });
    expect(useApp.getState().dimViolations.length).toBe(1);
    s.clearLocks();
  });

  it('is saved with the project and held by the optimizer', () => {
    const d = defaultDesign();
    d.dimensions = [{ id: 'x', root: 'FL', a: 'trInner', b: 'trOuter', measure: 'distance', value: 340, travel: null },
      { id: 'y', root: 'FL', a: 'lcaFwd', b: 'lcaOut', measure: 'front', value: 2, travel: 0 }];
    const r = importProject(JSON.parse(JSON.stringify(serializeProject(d, 'Dims'))));
    expect(r.warnings).toEqual([]);
    expect(r.design.dimensions.map(({ id: _id, ...rest }) => rest)).toEqual(d.dimensions.map(({ id: _id, ...rest }) => rest));
    const b = buildProblem({ ...d, optimizer: {} } as AppState);
    expect(b.problem.holds).toEqual([
      { dimension: { a: 'trInner', b: 'trOuter', measure: 'distance', value: 340, travel: null } },
      { dimension: { a: 'lcaFwd', b: 'lcaOut', measure: 'front', value: 2, travel: 0 } },
    ]);
  });
});
