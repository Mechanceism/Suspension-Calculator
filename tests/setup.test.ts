import { describe, it, expect } from 'vitest';
import { cgFromScales, springFromWeight, unsprungFromParts, estimateInertia, G } from '../src/core/setup/measure';
import { useApp, defaultDesign, resolvedCorner } from '../src/app/store';
import { serializeProject, importProject } from '../src/app/project';

describe('setup wizard measurements', () => {
  it('corner scales give the mass, the CG position and (with one axle lifted) the CG height', () => {
    // A known car: 300 kg, CG 47 % of the wheelbase behind the front axle, 10 mm left, 280 mm high.
    const L = 1550, t = 1200, m = 300, a = 0.47 * L, h = 280, r = 230, x = 10;
    const front = m * (1 - a / L), rear = m - front;
    const level = { FL: front / 2 + (front * x) / t, FR: front / 2 - (front * x) / t, RL: rear / 2 + (rear * x) / t, RR: rear / 2 - (rear * x) / t };
    // Lift the front by H: the rear carries more. Exact for a rigid body pivoting at the rear wheel centers.
    const H = 250, th = Math.asin(H / L);
    const rearLifted = m * ((a * Math.cos(th) + (h - r) * Math.sin(th)) / (L * Math.cos(th)));
    const c = cgFromScales(level, L, t, t, { axle: 'front', height: H, groundAxleKg: rearLifted, wheelCenterHeight: r })!;
    expect(c.mass).toBeCloseTo(m, 9);
    expect(c.z).toBeCloseTo(-a, 6);
    expect(c.x).toBeCloseTo(x, 6);
    expect(c.height!).toBeCloseTo(h, 3);
    expect(cgFromScales(level, L, t, t)!.height).toBeNull();
  });

  it('spring rate from an added weight: ride rate, tire taken out, motion ratio', () => {
    const r = springFromWeight(50, 10, 0.8, 200)!;
    expect(r.rideRate).toBeCloseTo((50 * G) / 10, 9);
    expect(1 / r.wheelRate + 1 / 200).toBeCloseTo(1 / r.rideRate, 9);
    expect(r.springRate).toBeCloseTo(r.wheelRate / 0.64, 9);
    expect(springFromWeight(50, 0, 0.8)).toBeNull();
  });

  it('unsprung mass counts half of the parts that join the body; inertias scale with size', () => {
    expect(unsprungFromParts({ wheelTire: 8, hubUpright: 3, brake: 2, arms: 2, springDamper: 2, halfshaft: 1, other: 0 })).toBe(15.5);
    const i = estimateInertia(250, 1200, 1550);
    expect(i.roll).toBeCloseTo(250 * 0.42 ** 2, 6);
    expect(i.pitch).toBeCloseTo(250 * 0.62 ** 2, 6);
  });
});

describe('setup wizard in the app', () => {
  it('changes every design on an axle and saves which steps are estimates', () => {
    useApp.setState({ ...defaultDesign(), links: { frontPair: true, rearPair: true, rearFromFront: false }, activeCorner: 'FL' });
    useApp.getState().updateDesigns('rear', (d) => ({ ...d, spring: { ...d.spring, unsprungMass: { text: '20', value: 20 } } }));
    const at = (id: 'FL' | 'RL' | 'RR') => resolvedCorner(useApp.getState(), id);
    expect(at('RL').spring.unsprungMass.value).toBe(20);
    expect(at('RR').spring.unsprungMass.value).toBe(20);
    expect(at('FL').spring.unsprungMass.value).not.toBe(20);
    useApp.getState().setSetupStatus('weight', 'entered');
    useApp.getState().setSetupStatus('inertia', 'estimated');
    const d = defaultDesign();
    d.setupStatus = useApp.getState().setupStatus;
    const back = importProject(JSON.parse(JSON.stringify(serializeProject(d, 'W')))).design;
    expect(back.setupStatus).toEqual({ weight: 'entered', inertia: 'estimated' });
  });
});

