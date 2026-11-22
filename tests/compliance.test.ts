import { describe, it, expect } from 'vitest';
import { DoubleWishbone, characteristics } from '../src/core';
import { SAMPLE_LAYOUTS, SAMPLE_MACPHERSON } from '../src/examples/sampleLayouts';

const C = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;

describe('compliance steer and camber (bushings)', () => {
  it('scales as 1 / bushing stiffness and vanishes when they are rigid', () => {
    const c = new DoubleWishbone(C);
    const s = c.design();
    const soft = c.compliance(s, { radial: 2000, axial: 600 })!;
    const stiff = c.compliance(s, { radial: 20000, axial: 6000 })!;
    expect(soft).not.toBeNull();
    expect(Math.abs(soft.lateral.camber)).toBeGreaterThan(1e-3);
    expect(soft.lateral.camber / stiff.lateral.camber).toBeCloseTo(10, 0);
    expect(soft.braking.toe / stiff.braking.toe).toBeCloseTo(10, 0);
    // Magnitudes like a real car's (a few hundredths to tenths of a degree per kN).
    expect(Math.abs(soft.lateral.camber)).toBeLessThan(1);
    const rigid = c.compliance(s, { radial: 1e9, axial: 1e9 })!;
    expect(Math.abs(rigid.lateral.toe) + Math.abs(rigid.lateral.camber)).toBeLessThan(1e-4);
    // The state itself isn't changed.
    expect(characteristics(c.design()).toe).toBeCloseTo(characteristics(s).toe, 12);
  });
  it('a side force pushing the tire inboard leans the wheel top outboard (positive camber) on a double wishbone', () => {
    const r = new DoubleWishbone(C).compliance(new DoubleWishbone(C).design())!;
    expect(r.lateral.camber).toBeGreaterThan(0);
    expect(new DoubleWishbone(SAMPLE_MACPHERSON).compliance(new DoubleWishbone(SAMPLE_MACPHERSON).design())).not.toBeNull();
  });
});
