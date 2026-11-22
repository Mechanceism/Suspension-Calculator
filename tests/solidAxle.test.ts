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

describe('solid axle on the car', () => {
  it('a 3-link + Panhard rear axle settles, corners about its roll center and couples the two wheels over a bump', async () => {
    const { assembleVehicle, solveCase, rideRun, characteristics, DoubleWishbone, DEFAULT_MF } = await import('../src/core');
    const { SAMPLE_LAYOUTS, SAMPLE_SPRING } = await import('../src/examples/sampleLayouts');
    const C = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
    // The same ground as the front (wheel radius 260, center at y = 160): everything 140 mm lower than above.
    const sh = (v: { x: number; y: number; z: number }) => vec3(v.x, v.y - 140, v.z);
    const rear: SolidAxleGeometry = {
      kind: 'solidAxle',
      wheel: { center: vec3(600, 160, 0), spinAxis: vec3(1, 0, 0), radius: 260, width: 205 },
      links: threeLink.links.map((l) => ({ ...l, chassis: sh(l.chassis), axle: sh(l.axle) })),
      springs: { left: { chassis: vec3(400, 500, -20), axle: vec3(400, 190, -20) } },
    };
    const gas = { kind: 'gas' as const, volumeChange: true, volumeFactor: 1, conditions: { setPressure: 83, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 } };
    const profile = { radius: 260, width: 205, shoulderRadius: 25, rimRadius: 165 };
    const p = {
      designs: { FL: { geometry: C, profile, model: gas, springRate: SAMPLE_SPRING.rate, freeLength: SAMPLE_SPRING.freeLength, unsprungMass: 12, damping: { bump: 1500, rebound: 2500 } } },
      roots: { FL: 'FL', FR: 'FL', RL: 'FL', RR: 'FL' } as const,
      settings: { FL: { brake: 'outboard', drive: 'none' }, FR: { brake: 'outboard', drive: 'none' }, RL: { brake: 'outboard', drive: 'chassis' }, RR: { brake: 'outboard', drive: 'chassis' } } as const,
      mass: 300, cg: { x: 0, height: 280, z: -0.47 * 1550 }, wheelbase: 1550, brakeBias: 0.6, driveSplit: 0.5, autoPreload: true,
      shared: { front: { antiRollBar: { kind: 'none' as const }, heaveSpring: { kind: 'none' as const } }, rear: { antiRollBar: { kind: 'none' as const }, heaveSpring: { kind: 'none' as const } } },
      dropLinks: { front: null, rear: null }, droop: 40, bump: 40, cases: { lateralG: 0, brakingG: 0, accelG: 0 }, goals: [], variables: [],
      steering: { steered: { FL: true, FR: true }, rackLimit: 30, cFactor: 75 }, ride: { rollInertia: 35, pitchInertia: 100, tireDamping: 100 }, tireGrip: DEFAULT_MF,
      axles: { rear },
    };
    const asm = assembleVehicle(p as never, { FL: C })!;
    expect(asm).not.toBeNull();
    expect(asm.chars.RL.rollCenterHeight!).toBeCloseTo(260, 0); // the Panhard rod (y = 160) above the ground (y = −100)
    const rest = solveCase(p as never, asm, { name: 'r', kind: 'state', g: 0, lateralG: 0, brakingG: 0, accelG: 0 })!.result;
    expect(rest.converged).toBe(true);
    for (const id of ['RL', 'RR'] as const) expect(Math.abs(rest.corners[id].travel)).toBeLessThan(1.5); // preload fitted
    const turn = solveCase(p as never, asm, { name: 't', kind: 'state', g: 0.6, lateralG: 0.6, brakingG: 0, accelG: 0 })!.result;
    expect(turn.converged).toBe(true);
    expect(turn.corners.RR.tireLoad).toBeGreaterThan(turn.corners.RL.tireLoad);
    // The rear wheels stay on one rigid axle: their camber to the body changes together, opposite signs.
    expect(Math.sign(turn.corners.RL.travel)).toBe(-Math.sign(turn.corners.RR.travel));
    // Rear geometric transfer through the high roll center: more of the rear transfer goes through the links than at the front.
    const fr = characteristics(new DoubleWishbone(C).design()).rollCenterHeight!;
    expect(asm.chars.RL.rollCenterHeight!).toBeGreaterThan(fr);
    // A bump under one rear wheel moves the other rear wheel's load too (shared axle).
    const bump = (side: 'RL' | 'RR') => rideRun(p as never, { FL: C }, [{ distance: 12, v0: 10, v1: 10, path: 'straight', radius: 0, grade: 0, bank: 0, bumps: { [side]: 25 } }], {});
    const r = bump('RL');
    expect(r.error).toBeUndefined();
    const lastF = r.frames.at(-1)!;
    expect(lastF.ride!.travel.RL - lastF.ride!.travel.RR).toBeGreaterThan(5);
    expect(r.findings.flat().filter((f) => f.check === 'noSolution')).toEqual([]);
  });
});
