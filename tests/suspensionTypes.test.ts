import { describe, it, expect } from 'vitest';
import { DoubleWishbone, characteristics, screwAxis, virtualPivot, vec3, sub, dot, normalize, length, cross, type DoubleWishboneGeometry } from '../src/core';
import { SAMPLE_LAYOUTS, SAMPLE_MACPHERSON, SAMPLE_MULTILINK } from '../src/examples/sampleLayouts';

const C = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
const deg = (r: number) => (r * 180) / Math.PI;
const travels = [-50, -25, 0, 25, 50];

describe('suspension types', () => {
  it('a multilink whose link pairs share their upright end moves exactly like the double wishbone', () => {
    const ml: DoubleWishboneGeometry = { ...C, kind: 'multilink' };
    const a = new DoubleWishbone(C).sweep(travels, (t) => ({ travel: t }));
    const b = new DoubleWishbone(ml).sweep(travels, (t) => ({ travel: t }));
    a.forEach((s, i) => {
      expect(b[i]!.solve.status).toBe('converged');
      const ca = characteristics(s), cb = characteristics(b[i]!);
      expect(cb.camber).toBeCloseTo(ca.camber, 7);
      expect(cb.toe).toBeCloseTo(ca.toe, 7);
      expect(cb.kpi).toBeCloseTo(ca.kpi, 6);
      expect(cb.caster).toBeCloseTo(ca.caster, 6);
      // Its instant axis comes from the pivots' velocities (links); with joined ends it is the arm planes' axis.
      expect(cb.fvsa).toBeCloseTo(ca.fvsa, 3);
      expect(cb.svsa).toBeCloseTo(ca.svsa, 2);
      expect(cb.rollCenterHeight!).toBeCloseTo(ca.rollCenterHeight!, 4);
    });
  });

  it('MacPherson: the strut stays on its top mount, slides with travel, and the steering axis runs LBJ → top mount', () => {
    const c = new DoubleWishbone(SAMPLE_MACPHERSON);
    expect(c.bodies).toEqual(['lca', 'upright']);
    const states = c.sweep(travels, (t) => ({ travel: t }));
    const top = SAMPLE_MACPHERSON.damper!.chassis;
    const lens: number[] = [];
    for (const s of states) {
      expect(s.solve.status).toBe('converged');
      const p = s.points;
      // The top mount is on the strut axis (lower point → its upright-fixed top).
      const u = normalize(sub(p.strutLower!, top));
      const off = length(cross(sub(top, p.strutLower!), u));
      expect(off).toBeLessThan(1e-6);
      lens.push(length(sub(p.damperArm!, p.damperChassis!)));
      expect(p.steerUpper).toEqual(top);
      const ch = characteristics(s);
      const axis = normalize(sub(top, p.lcaOut));
      expect(ch.kpi).toBeCloseTo(Math.atan2(-axis.x, axis.y), 9);
    }
    // The strut shortens in bump about as much as the wheel rises (motion ratio near 1).
    const mr = (lens[0]! - lens[4]!) / 100;
    expect(mr).toBeGreaterThan(0.8);
    expect(mr).toBeLessThan(1.05);
    const ch0 = characteristics(states[2]!);
    expect(deg(ch0.kpi)).toBeCloseTo(13.6, 0);
    // Front-view IC: the lower-arm line and the line through the top mount normal to the strut (front view).
    const l0 = SAMPLE_MACPHERSON.lca;
    const z = ch0.contactPoint.z;
    const ic = ch0.frontViewIC!;
    expect(ic).not.toBeNull();
    // On the plane normal to the strut through the top mount:
    expect(Math.abs(dot(sub(ic, top), normalize(sub(top, states[2]!.points.strutLower!))))).toBeLessThan(1e-6);
    expect(ic.z).toBeCloseTo(z, 6);
    void l0;
  });

  it('MacPherson steers about the LBJ – top mount axis', () => {
    const c = new DoubleWishbone(SAMPLE_MACPHERSON);
    const s0 = c.solve({}), s1 = c.solve({ rack: 10 });
    expect(s1.solve.status).toBe('converged');
    expect(Math.abs(characteristics(s1).toe - characteristics(s0).toe)).toBeGreaterThan(0.02);
    // The strut top stays put; the lower ball joint stays on the arm.
    expect(length(sub(s1.points.lcaOut, s0.points.lcaOut))).toBeLessThan(1);
  });

  it('multilink with five separate links: solves through travel, has a virtual steering axis and a screw axis', () => {
    const c = new DoubleWishbone(SAMPLE_MULTILINK);
    expect(c.bodies).toEqual(['upright']);
    const states = c.sweep(travels, (t) => ({ travel: t }));
    for (const s of states) {
      expect(s.solve.status).toBe('converged');
      // Every link keeps its length.
      const p = s.points;
      const g = SAMPLE_MULTILINK;
      expect(length(sub(p.ucaOut2!, g.uca.aft))).toBeCloseTo(length(sub(g.uca.out2!, g.uca.aft)), 6);
      expect(length(sub(p.lcaOut2!, g.lca.aft))).toBeCloseTo(length(sub(g.lca.out2!, g.lca.aft)), 6);
      const ch = characteristics(s);
      expect(Number.isFinite(ch.kpi) && Number.isFinite(ch.caster)).toBe(true);
      expect(ch.instantAxis).not.toBeNull();
      expect(Number.isFinite(ch.rollCenterHeight!)).toBe(true);
    }
    // The virtual pivot of two crossing links is where they cross.
    expect(virtualPivot(vec3(0, 0, 0), vec3(2, 0, 0), vec3(1, -1, 0), vec3(1, 1, 0))).toEqual(vec3(1, 0, 0));
    // A drop-link mount "on the lower arm" goes on the upright (there is no lower arm body).
    const s = states[4]!;
    const pt = vec3(500, 60, 0);
    expect(c.pointOn(s, 'lca', pt)).toEqual(c.pointOn(s, 'upright', pt));
    expect(c.designPointOf(s, 'lca', c.pointOn(s, 'lca', pt)).x).toBeCloseTo(500, 6);
  });

  it('the screw axis (five links) exists and passes near the instant axis', () => {
    const s = new DoubleWishbone({ ...C, kind: 'multilink' }).solve({});
    const ax = screwAxis(s.points)!;
    const planes = characteristics(new DoubleWishbone(C).solve({})).instantAxis!;
    // The screw axis also holds the small turn about the steering axis from the tie rod: close, not equal.
    expect(Math.abs(dot(ax.dir, planes.dir))).toBeGreaterThan(0.9);
  });

  it('broken MacPherson input is refused with the reason', () => {
    expect(() => new DoubleWishbone({ ...SAMPLE_MACPHERSON, damper: undefined })).toThrow(/strut/);
  });
});

describe('mixed suspension types on one car', () => {
  it('MacPherson front + multilink rear: settles, corners, brakes and drives a test with handling', async () => {
    const { assembleVehicle, solveCase, rideRun, steerTable, effAt, DEFAULT_MF } = await import('../src/core');
    const { SAMPLE_SPRING } = await import('../src/examples/sampleLayouts');
    const gas = { kind: 'gas' as const, volumeChange: true, volumeFactor: 1, conditions: { setPressure: 83, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 } };
    const profile = { radius: 260, width: 205, shoulderRadius: 25, rimRadius: 165 };
    const d = (geometry: DoubleWishboneGeometry) => ({ geometry, profile, model: gas, springRate: SAMPLE_SPRING.rate, freeLength: SAMPLE_SPRING.freeLength, unsprungMass: 12, damping: { bump: 1500, rebound: 2500 } });
    const p = {
      designs: { FL: d(SAMPLE_MACPHERSON), RL: d(SAMPLE_MULTILINK) }, roots: { FL: 'FL', FR: 'FL', RL: 'RL', RR: 'RL' } as const,
      settings: { FL: { brake: 'outboard', drive: 'none' }, FR: { brake: 'outboard', drive: 'none' }, RL: { brake: 'outboard', drive: 'chassis' }, RR: { brake: 'outboard', drive: 'chassis' } } as const,
      mass: 300, cg: { x: 0, height: 280, z: -0.47 * 1550 }, wheelbase: 1550, brakeBias: 0.6, driveSplit: 0.5, autoPreload: true,
      shared: { front: { antiRollBar: { kind: 'none' as const }, heaveSpring: { kind: 'none' as const } }, rear: { antiRollBar: { kind: 'wheelRate' as const, rate: 10 }, heaveSpring: { kind: 'none' as const } } },
      dropLinks: { front: null, rear: null }, droop: 50, bump: 50, cases: { lateralG: 0, brakingG: 0, accelG: 0 }, goals: [], variables: [],
      steering: { steered: { FL: true, FR: true }, rackLimit: 30, cFactor: 75 },
      ride: { rollInertia: 35, pitchInertia: 100, tireDamping: 100 }, tireGrip: DEFAULT_MF,
    };
    const geoms = { FL: SAMPLE_MACPHERSON, RL: SAMPLE_MULTILINK };
    const asm = assembleVehicle(p as never, geoms)!;
    expect(asm).not.toBeNull();
    const rest = solveCase(p as never, asm, { name: 'rest', kind: 'state', g: 0, lateralG: 0, brakingG: 0, accelG: 0 })!.result;
    expect(rest.converged).toBe(true);
    expect(Math.abs(rest.pose.roll)).toBeLessThan(1e-4);
    const turn = solveCase(p as never, asm, { name: 't', kind: 'state', g: 0.8, lateralG: 0.8, brakingG: 0, accelG: 0 })!.result;
    expect(turn.converged).toBe(true);
    expect(turn.corners.FR.tireLoad).toBeGreaterThan(turn.corners.FL.tireLoad);
    const brake = solveCase(p as never, asm, { name: 'b', kind: 'state', g: 0.8, lateralG: 0, brakingG: 0.8, accelG: 0 })!.result;
    expect(brake.converged).toBe(true);
    expect(brake.corners.FL.tireLoad).toBeGreaterThan(rest.corners.FL.tireLoad);
    // Steering kinematics of the strut.
    const t = steerTable(p as never, asm);
    expect(t.none).toBe(false);
    expect(Math.abs(effAt(t, t.limit, 0))).toBeGreaterThan(0.1);
    const r = rideRun(p as never, geoms, [
      { distance: 15, v0: 12, v1: 12, path: 'straight', radius: 0, grade: 0, bank: 0 },
      { distance: 50, v0: 12, v1: 12, path: 'left', radius: 30, grade: 0, bank: 0 },
    ], { handling: true });
    expect(r.error).toBeUndefined();
    expect(r.metrics.maxPathError!).toBeLessThan(0.5);
    expect(r.findings.flat().filter((f) => f.check === 'noSolution')).toEqual([]);
  });
});
