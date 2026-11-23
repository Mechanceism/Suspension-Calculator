import { describe, it, expect } from 'vitest';
import { racingLineRadius } from '../src/core';
import { segmentSpec, newSegment } from '../src/app/tests';

describe('racing line', () => {
  it('the widest arc: 90° R 20 m with 8 m of width is R_inside + w / (1 − cos 45°) ≈ 43 m; no width = the path', () => {
    const r = racingLineRadius(20, (20 * Math.PI) / 2, 8);
    expect(r).toBeCloseTo(16 + 8 / (1 - Math.cos(Math.PI / 4)), 6);
    expect(racingLineRadius(20, 31, 0)).toBe(20);
    // A hairpin gains less than a gentle bend.
    expect(racingLineRadius(20, 20 * Math.PI, 8) / 20).toBeLessThan(racingLineRadius(20, 10, 8) / 20);
  });
  it('a test with the racing line uses it for segments with a width', () => {
    const seg = { ...newSegment({ path: 'left', radius: { text: '20', value: 20 }, distance: { text: '31.4', value: 31.4 } }), width: { text: '8', value: 8 } };
    const test = { racingLine: true, segments: [seg], checks: undefined } as never;
    expect(segmentSpec(seg, test).radius).toBeCloseTo(43.3, 0);
    expect(segmentSpec(seg, { ...(test as object), racingLine: false } as never).radius).toBe(20);
  });
});
