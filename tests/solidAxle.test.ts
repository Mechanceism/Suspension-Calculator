import { describe, it, expect } from 'vitest';
import { SolidAxle, axleCharacteristics, mirroredLinks, vec3, type SolidAxleGeometry } from '../src/core';

const D = 180 / Math.PI;
// Ground at y = 0, wheel radius 300: left wheel center at (650, 300, 0).
const threeLink: SolidAxleGeometry = {
  kind: 'solidAxle',
  wheel: { center: vec3(650, 300, 0), spinAxis: vec3(1, 0, 0), radius: 300, width: 250 },
  links: [
    ...mirroredLinks([{ name: 'lower', chassis: vec3(450, 100, 500), axle: vec3(450, 100, 0) }]),
    { name: 'upper (center)', chassis: vec3(0, 250, 400), axle: vec3(0, 300, 0) },
    { name: 'Panhard rod', chassis: vec3(-450, 300, -50), axle: vec3(450, 300, -50) },
  ],
  springs: { left: { chassis: vec3(400, 650, -20), axle: vec3(400, 330, -20) } },
};

describe('solid axle', () => {
  const a = new SolidAxle(threeLink);
  it('heave and roll solve; the axle stays rigid', () => {
    for (const [l, r] of [[0, 0], [40, 40], [-40, -40], [30, -30], [-25, 35]]) {
      const s = a.solve({ left: l, right: r });
      expect(s.solve.status).toBe('converged');
      expect(s.left.center.y).toBeCloseTo(300 + l!, 6);
      expect(s.right.center.y).toBeCloseTo(300 + r!, 6);
      expect(Math.hypot(s.left.center.x - s.right.center.x, s.left.center.y - s.right.center.y, s.left.center.z - s.right.center.z)).toBeCloseTo(1300, 6);
    }
  });

  it('roll center at the Panhard rod height; camber follows the axle; side-view IC where the link lines cross', () => {
    const s = a.design();
    const c = axleCharacteristics(a, s);
    expect(c.rollCenterHeight!).toBeCloseTo(300, 0);
    expect(c.camber.left).toBeCloseTo(0, 9);
    // Heave keeps camber (a solid axle); in roll each wheel tilts with the axle.
    const roll = a.solve({ left: 30, right: -30 });
    const phi = Math.atan2(60, 1300);
    expect(axleCharacteristics(a, roll).camber.left).toBeCloseTo(-phi, 3); // left up: top leans inboard (−)
    expect(axleCharacteristics(a, roll).camber.right).toBeCloseTo(phi, 3);
    // Lower links y = 100; upper link y = 300 − z·50/400 → cross at z = 1600.
    expect(c.sideViewIC!.y).toBeCloseTo(100, 0);
    expect(c.sideViewIC!.z).toBeCloseTo(1600, -1);
    expect(c.antiAngleContact * D).toBeCloseTo(Math.atan((100 - 0) / (0 - 1600)) * D, 0);
    // Symmetric links: no roll steer; the Panhard rod's arc moves the axle sideways only a little.
    expect(Math.abs(c.rollSteer)).toBeLessThan(0.01);
    expect(Math.abs(c.lateralShift)).toBeLessThan(0.05);
    // Springs shorten in bump.
    expect(a.solve({ left: 20, right: 20 }).springLength!.left).toBeLessThan(s.springLength!.left);
  });

  it('angled lower links give roll steer; a missing link is refused at the solve', () => {
    const steer = new SolidAxle({ ...threeLink, links: [
      ...mirroredLinks([{ name: 'lower', chassis: vec3(450, 180, 500), axle: vec3(450, 100, 0) }]),
      ...threeLink.links.slice(2),
    ] });
    expect(Math.abs(axleCharacteristics(steer, steer.design()).rollSteer)).toBeGreaterThan(0.02);
    const loose = new SolidAxle({ ...threeLink, links: threeLink.links.slice(0, 3) });
    expect(loose.solve({ left: 10, right: 10 }).solve.status).not.toBe('converged');
  });
});
