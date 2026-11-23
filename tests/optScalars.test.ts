import { describe, it, expect } from 'vitest';
import { optimizeCorner, withVariables, getPoint, staticCamberToe, characteristics, DoubleWishbone, armMetrics, type Variable } from '../src/core';
import { SAMPLE_LAYOUTS } from '../src/examples/sampleLayouts';

const geom = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
const D = 180 / Math.PI;

describe('optimizer: setup values and length ranges', () => {
  it('static camber and toe as variables set the wheel exactly', () => {
    const g = withVariables(geom, [{ point: 'staticCamber', axis: 0, lo: -3, hi: 3 }, { point: 'staticToe', axis: 0, lo: -1, hi: 1 }], [-1.5, 0.2]);
    expect(staticCamberToe(g).camber).toBeCloseTo(-1.5, 9);
    expect(staticCamberToe(g).toe).toBeCloseTo(0.2, 9);
    expect(characteristics(new DoubleWishbone(g).design()).camber * D).toBeCloseTo(-1.5, 6);
  });
  it('a length range holds while the goals pull the arm', () => {
    const v = getPoint(geom, 'ucaFwd')!;
    const vars: Variable[] = [{ point: 'ucaFwd', axis: 0, lo: v.x - 80, hi: v.x + 80 }, { point: 'ucaAft', axis: 0, lo: v.x - 80, hi: v.x + 80 }];
    const goals = [{ kind: 'camberGain' as const, target: -0.08, weight: 1 }];
    const free = optimizeCorner({ geometry: geom, droop: -40, bump: 40, goals, variables: vars });
    const r = optimizeCorner({ geometry: geom, droop: -40, bump: 40, goals, variables: vars, ranges: [{ hold: { arm: 'uca', which: 'length' }, lo: 270, hi: 300 }] });
    const ucaLen = (g: typeof geom) => armMetrics(g.uca).length;
    expect(Math.abs(ucaLen(free.geometry) - ucaLen(geom))).toBeGreaterThan(5); // the goal does pull it
    expect(ucaLen(r.geometry)).toBeGreaterThan(270 - 0.1);
    expect(ucaLen(r.geometry)).toBeLessThan(300 + 0.1);
  });
});
