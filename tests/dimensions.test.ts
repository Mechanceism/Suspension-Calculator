import { describe, it, expect } from 'vitest';
import {
  resolveDimensions, dimensionValue, withVariables, optimizeCorner, getPoint,
  type DimensionSpec, type Variable,
} from '../src/core';
import { SAMPLE_LAYOUTS } from '../src/examples/sampleLayouts';

const geom = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;

describe('held dimensions', () => {
  it('a permanent pivot spacing is kept when one pivot is moved: the other follows', () => {
    const d: DimensionSpec = { a: 'ucaFwd', b: 'ucaAft', measure: 'distance', value: dimensionValue(geom, { a: 'ucaFwd', b: 'ucaAft', measure: 'distance', value: 0, travel: null })!, travel: null };
    const edited = withVariables(geom, [{ point: 'ucaFwd', axis: 2, lo: -1e4, hi: 1e4 }], [geom.uca.fwd.z + 20]);
    const r = resolveDimensions(edited, [d], (p, axis) => p === 'ucaFwd' && axis === 2);
    expect(r.violated).toEqual([]);
    expect(dimensionValue(r.geometry, d)!).toBeCloseTo(d.value, 2);
    expect(r.geometry.uca.fwd.z).toBe(geom.uca.fwd.z + 20); // the edit stands
    expect(r.moved.every((m) => m.point === 'ucaAft' || m.point === 'ucaFwd')).toBe(true);
    // Moving as little as possible: the rear pivot followed mostly along Z.
    expect(Math.abs(r.geometry.uca.aft.z - geom.uca.aft.z - 20)).toBeLessThan(1);
  });

  it('an angle held at ride height (travel 0) is met after an edit; nothing moves when already met', () => {
    const d: DimensionSpec = { a: 'lcaFwd', b: 'lcaOut', measure: 'front', value: 3, travel: 0 };
    const r = resolveDimensions(geom, [d], () => false);
    expect(dimensionValue(r.geometry, d)!).toBeCloseTo(3, 2);
    const again = resolveDimensions(r.geometry, [d], () => false);
    expect(again.moved).toEqual([]);
  });

  it('a dimension held at a travel position is met at that travel', () => {
    const d: DimensionSpec = { a: 'trInner', b: 'trOuter', measure: 'front', value: 1.5, travel: 30 };
    const r = resolveDimensions(geom, [d], (p) => p === 'trOuter'); // only the inner tie-rod end may move
    expect(r.violated).toEqual([]);
    expect(dimensionValue(r.geometry, d)!).toBeCloseTo(1.5, 2);
  });

  it('reports a dimension it cannot meet (everything involved is fixed)', () => {
    const d: DimensionSpec = { a: 'ucaFwd', b: 'ucaAft', measure: 'distance', value: 10, travel: null };
    const r = resolveDimensions(geom, [d], () => true);
    expect(r.violated).toEqual([0]);
  });

  it('the optimizer keeps held dimensions', () => {
    const v = getPoint(geom, 'trInner')!;
    const vars: Variable[] = [
      { point: 'trInner', axis: 0, lo: v.x - 30, hi: v.x + 30 }, { point: 'trInner', axis: 1, lo: v.y - 30, hi: v.y + 30 },
      { point: 'trOuter', axis: 1, lo: 70, hi: 130 },
    ];
    const start = withVariables(geom, [vars[1]!], [v.y + 25]);
    const length0 = dimensionValue(start, { a: 'trInner', b: 'trOuter', measure: 'distance', value: 0, travel: null })!;
    const d: DimensionSpec = { a: 'trInner', b: 'trOuter', measure: 'distance', value: length0, travel: null };
    const r = optimizeCorner({ geometry: start, droop: -50, bump: 50, goals: [{ kind: 'bumpSteer', target: 0, weight: 1 }], variables: vars, holds: [{ dimension: d }] });
    expect(dimensionValue(r.geometry, d)!).toBeCloseTo(length0, 1);
    expect(r.goals[0]!.after!).toBeLessThan(r.goals[0]!.before!);
  });
});
