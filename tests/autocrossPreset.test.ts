import { describe, it, expect } from 'vitest';
import { TEST_PRESETS, segmentSpec } from '../src/app/tests';

const preset = (label: string) => TEST_PRESETS.find((p) => p.label.startsWith(label))!.make();

describe('autocross presets', () => {
  it('the original is now "Autocross (simple)"; the complex one sits right after it', () => {
    expect(TEST_PRESETS[0]!.label).toBe('Autocross (simple)');
    expect(TEST_PRESETS[1]!.label).toMatch(/^Autocross \(complex\)/);
  });

  it('complex: flat, balanced left / right, straight overall, continuous speeds', () => {
    const specs = preset('Autocross (complex)').segments.map((s) => segmentSpec(s));
    // Flat: no bank, no grade, no bumps.
    for (const s of specs) { expect(s.bank).toBe(0); expect(s.grade).toBe(0); expect(s.road).toBeUndefined(); }
    // Each turn: (radius, length); the left and right sets are the same, so both sides work equally.
    const turns = (side: 'left' | 'right') => specs.filter((s) => s.path === side).map((s) => `${s.radius}/${s.distance.toFixed(3)}@${s.v0.toFixed(3)}`).sort();
    expect(turns('left')).toEqual(turns('right'));
    expect(turns('left').length).toBe(7);
    // Every turn sequence ends on the heading it started on.
    let heading = 0, maxAbs = 0;
    for (const s of specs) {
      if (s.path !== 'straight') heading += (s.path === 'left' ? 1 : -1) * (s.distance / s.radius);
      maxAbs = Math.max(maxAbs, Math.abs(heading));
    }
    expect(heading).toBeCloseTo(0, 9);
    expect(maxAbs).toBeLessThan(Math.PI / 2 + 1e-9);
    // Speeds join up; constant through every turn; it starts and ends at rest.
    for (let i = 1; i < specs.length; i++) expect(specs[i]!.v0).toBeCloseTo(specs[i - 1]!.v1, 9);
    for (const s of specs.filter((x) => x.path !== 'straight')) expect(s.v1).toBeCloseTo(s.v0, 9);
    expect(specs[0]!.v0).toBe(0);
    expect(specs.at(-1)!.v1).toBe(0);
    // Quick direction changes: slalom and gates at about 0.7 g, sweepers about 0.6 g.
    const g = (s: (typeof specs)[number]) => (s.v0 * s.v0) / s.radius / 9.80665;
    for (const s of specs.filter((x) => x.path !== 'straight')) { expect(g(s)).toBeGreaterThan(0.55); expect(g(s)).toBeLessThan(0.8); }
  });
});
