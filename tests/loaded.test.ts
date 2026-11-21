import { describe, it, expect } from 'vitest';
import {
  DoubleWishbone, characteristics, loadCorner, spinAxisFromCamberToe, rad,
  type TireProfile, type TireForceModel,
} from '../src/core';
import { SAMPLE_LAYOUTS } from '../src/examples/sampleLayouts';

const geom = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
const profile: TireProfile = { radius: 260, width: 205, shoulderRadius: 25, rimRadius: 165 };
const gas: TireForceModel = {
  kind: 'gas', volumeChange: true, volumeFactor: 1,
  conditions: { setPressure: 83, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 },
};

describe('loadCorner', () => {
  it('carries the load and raises the ground by the tire deflection', () => {
    const s = new DoubleWishbone(geom).design();
    const c = characteristics(s);
    const l = loadCorner(s, c, profile, gas, 900);
    expect(l.force.force).toBeCloseTo(900, 2);
    expect(l.deflection).toBeGreaterThan(0);
    expect(l.groundY).toBeGreaterThan(c.groundY);
    expect(l.bottomedOut).toBe(false);
  });

  it('effective scrub equals geometric scrub at zero camber with a very stiff tire', () => {
    const s = new DoubleWishbone(geom).design();
    const c = characteristics(s);
    const l = loadCorner(s, c, profile, { kind: 'stiffness', rate: 1e7 }, 900);
    expect(l.deflection).toBeLessThan(1e-3);
    expect(l.effectiveScrubRadius).toBeCloseTo(c.scrubRadius, 2);
    expect(l.effectiveTrail).toBeCloseTo(c.mechanicalTrail, 2);
  });

  it('negative camber moves the patch centroid inboard, reducing effective scrub', () => {
    const cambered = { ...geom, wheel: { ...geom.wheel, spinAxis: spinAxisFromCamberToe(rad(-2), 0) } };
    const s = new DoubleWishbone(cambered).design();
    const c = characteristics(s);
    const l = loadCorner(s, c, profile, gas, 900);
    // Wheel center plane meets the loaded ground at x_cp; centroid sits inboard of it.
    const tan = Math.tan(rad(-2));
    const xCenterPlane = s.points.wheelCenter.x + (s.points.wheelCenter.y - l.groundY) * tan;
    expect(l.patch.centroid!.x).toBeLessThan(xCenterPlane);
  });
});
