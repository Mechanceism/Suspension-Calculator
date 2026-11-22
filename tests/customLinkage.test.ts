import { describe, it, expect } from 'vitest';
import {
  DoubleWishbone, characteristics, customFromWishbone, customFreedom, customProblems, multiLinks, assembleVehicle, solveCase, DEFAULT_MF,
  type CustomLinkage, type DoubleWishboneGeometry,
} from '../src/core';
import { SAMPLE_LAYOUTS, SAMPLE_MULTILINK, SAMPLE_SPRING } from '../src/examples/sampleLayouts';

const C = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
const custom = (g: DoubleWishboneGeometry, c: CustomLinkage): DoubleWishboneGeometry => ({ ...g, kind: 'custom', custom: c });
const travels = [-40, -20, 0, 20, 40];

describe('custom linkage', () => {
  it('built from a double wishbone it moves exactly like one: camber, toe, KPI, caster, instant centers, roll center', () => {
    const cw = custom(C, customFromWishbone(C));
    expect(customFreedom(cw.custom!)).toBe(1);
    const a = new DoubleWishbone(C).sweep(travels, (t) => ({ travel: t }));
    const b = new DoubleWishbone(cw).sweep(travels, (t) => ({ travel: t }));
    a.forEach((s, i) => {
      expect(b[i]!.solve.status).toBe('converged');
      const ca = characteristics(s), cb = characteristics(b[i]!);
      expect(cb.camber).toBeCloseTo(ca.camber, 8);
      expect(cb.toe).toBeCloseTo(ca.toe, 8);
      // Steering axis from the steering motion: the ball joints' line.
      expect(cb.kpi).toBeCloseTo(ca.kpi, 3);
      expect(cb.caster).toBeCloseTo(ca.caster, 3);
      // Instant axis from the travel motion: the arm planes' intersection (with the tie rod's small part).
      expect(cb.rollCenterHeight!).toBeCloseTo(ca.rollCenterHeight!, -0.5);
      expect(cb.fvsa / ca.fvsa).toBeCloseTo(1, 1);
    });
    // Steering turns it like the wishbone.
    const sa = characteristics(new DoubleWishbone(C).solve({ rack: 10 })), sb = characteristics(new DoubleWishbone(cw).solve({ rack: 10 }));
    expect(sb.toe).toBeCloseTo(sa.toe, 8);
    // The coilover on the lower arm body keeps its motion.
    expect(characteristics(b[4]!).damperLength!).toBeCloseTo(characteristics(a[4]!).damperLength!, 6);
  });

  it('five rods on the knuckle reproduce the multilink', () => {
    const links = multiLinks(SAMPLE_MULTILINK);
    const c: CustomLinkage = {
      bodies: [],
      joints: [
        ...links.map((l, i) => ({ id: `r${i}`, kind: 'rod' as const, name: l.name, a: 'chassis', b: 'upright', p: l.chassis, q: l.upright })),
        { id: 'tr', kind: 'rod', name: 'Tie rod', a: 'rack', b: 'upright', p: SAMPLE_MULTILINK.tieRod.inner, q: SAMPLE_MULTILINK.tieRod.outer },
      ],
    };
    const g = custom({ ...SAMPLE_MULTILINK, damper: { ...SAMPLE_MULTILINK.damper!, arm: 'upright' } }, c);
    const a = new DoubleWishbone(SAMPLE_MULTILINK).sweep(travels, (t) => ({ travel: t }));
    const b = new DoubleWishbone(g).sweep(travels, (t) => ({ travel: t }));
    a.forEach((s, i) => {
      expect(characteristics(b[i]!).camber).toBeCloseTo(characteristics(s).camber, 8);
      expect(characteristics(b[i]!).toe).toBeCloseTo(characteristics(s).toe, 8);
    });
  });

  it('says what is wrong with a linkage that can\'t work', () => {
    const base = customFromWishbone(C);
    const loose = { ...base, joints: base.joints.filter((j) => j.kind !== 'rod') }; // no tie rod: steers freely
    expect(customFreedom(loose)).toBe(2);
    expect(customProblems(loose).join(' ')).toMatch(/2 free motions/);
    expect(() => new DoubleWishbone(custom(C, loose))).toThrow(/free motions/);
    const tight = { ...base, joints: [...base.joints, { id: 'x', kind: 'rod' as const, name: 'Extra', a: 'chassis', b: 'upright', p: C.uca.fwd, q: C.wheel.center }] };
    expect(customProblems(tight).join(' ')).toMatch(/over-constrained by 1/);
    const lonely = { ...base, bodies: [...base.bodies, { id: 'b9', name: 'Bellcrank' }] };
    expect(customProblems(lonely).join(' ')).toMatch(/Bellcrank isn't joined/);
  });

  it('a layout of its own (lower arm + two rods to the knuckle top) solves, cambers and steers', () => {
    const c: CustomLinkage = {
      bodies: [{ id: 'arm', name: 'Lower arm' }],
      joints: [
        { id: 'h', kind: 'hinge', name: 'Arm pivot', a: 'chassis', b: 'arm', p: C.lca.fwd, q: C.lca.aft },
        { id: 'bj', kind: 'ball', name: 'Lower ball joint', a: 'arm', b: 'upright', p: C.lca.out },
        { id: 'r1', kind: 'rod', name: 'Front top link', a: 'chassis', b: 'upright', p: { ...C.uca.fwd, z: C.uca.fwd.z + 80 }, q: C.uca.out },
        { id: 'r2', kind: 'rod', name: 'Rear top link', a: 'chassis', b: 'upright', p: { ...C.uca.aft, z: C.uca.aft.z - 80 }, q: { ...C.uca.out, z: C.uca.out.z - 40 } },
        { id: 'tr', kind: 'rod', name: 'Tie rod', a: 'rack', b: 'upright', p: C.tieRod.inner, q: C.tieRod.outer },
      ],
      damperBody: 'arm',
    };
    expect(customProblems(c)).toEqual([]);
    const corner = new DoubleWishbone(custom(C, c));
    const s = corner.sweep(travels, (t) => ({ travel: t }));
    expect(s.every((x) => x.solve.status === 'converged')).toBe(true);
    const ch = s.map((x) => characteristics(x));
    expect(Math.abs(ch[4]!.camber - ch[0]!.camber)).toBeGreaterThan(0.005);
    expect(ch[2]!.rollCenterHeight).not.toBeNull();
    expect(Number.isFinite(ch[2]!.kpi)).toBe(true);
    expect(Math.abs(characteristics(corner.solve({ rack: 10 })).toe - ch[2]!.toe)).toBeGreaterThan(0.02);
  });

  it('works on the whole car', () => {
    const cw = custom(C, customFromWishbone(C));
    const gas = { kind: 'gas' as const, volumeChange: true, volumeFactor: 1, conditions: { setPressure: 83, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 } };
    const d = (geometry: DoubleWishboneGeometry) => ({ geometry, profile: { radius: 260, width: 205, shoulderRadius: 25, rimRadius: 165 }, model: gas, springRate: SAMPLE_SPRING.rate, freeLength: SAMPLE_SPRING.freeLength, unsprungMass: 15 });
    const p = {
      designs: { FL: d(cw), RL: d(C) }, roots: { FL: 'FL', FR: 'FL', RL: 'RL', RR: 'RL' } as const,
      settings: { FL: { brake: 'outboard', drive: 'none' }, FR: { brake: 'outboard', drive: 'none' }, RL: { brake: 'outboard', drive: 'chassis' }, RR: { brake: 'outboard', drive: 'chassis' } } as const,
      mass: 300, cg: { x: 0, height: 280, z: -0.47 * 1550 }, wheelbase: 1550, brakeBias: 0.6, driveSplit: 0.5, autoPreload: true,
      shared: { front: { antiRollBar: { kind: 'none' as const }, heaveSpring: { kind: 'none' as const } }, rear: { antiRollBar: { kind: 'none' as const }, heaveSpring: { kind: 'none' as const } } },
      dropLinks: { front: null, rear: null }, droop: 40, bump: 40, cases: { lateralG: 0, brakingG: 0, accelG: 0 }, goals: [], variables: [], tireGrip: DEFAULT_MF,
    };
    const asm = assembleVehicle(p as never, { FL: cw, RL: C })!;
    expect(asm).not.toBeNull();
    const r = solveCase(p as never, asm, { name: 't', kind: 'state', g: 0.6, lateralG: 0.6, brakingG: 0.3, accelG: 0 })!.result;
    expect(r.converged).toBe(true);
  });
});

describe('custom linkage in the app', () => {
  it('switching to it starts from the current arms (same motion), keeps it when switching away and back, and saves', async () => {
    const { editableFromLayout, convertGeometry, toGeometry, defaultDesign } = await import('../src/app/store');
    const { serializeProject, importProject } = await import('../src/app/project');
    const dw = editableFromLayout('C');
    const e = convertGeometry(dw, 'custom');
    expect(e.custom!.joints).toHaveLength(5);
    const a = characteristics(new DoubleWishbone(toGeometry(dw)).solve({ travel: 30 }));
    const b = characteristics(new DoubleWishbone(toGeometry(e)).solve({ travel: 30 }));
    expect(b.camber).toBeCloseTo(a.camber, 8);
    expect(characteristics(new DoubleWishbone(toGeometry(e)).design()).damperLength!).toBeCloseTo(characteristics(new DoubleWishbone(toGeometry(dw)).design()).damperLength!, 6);
    // Edit it, switch away and back: the edit is kept.
    const edited = { ...e, custom: { ...e.custom!, bodies: [...e.custom!.bodies, { id: 'b1', name: 'Bellcrank' }] } };
    const back = convertGeometry(convertGeometry(edited, 'doubleWishbone'), 'custom');
    expect(back.custom!.bodies.map((x) => x.name)).toContain('Bellcrank');
    // Saved and read back.
    const d = defaultDesign();
    d.corners.FL = { ...d.corners.FL, geom: e };
    d.geom = e; // the active design (FL) is what gets saved
    const r = importProject(JSON.parse(JSON.stringify(serializeProject(d, 'C'))));
    expect(r.design.corners.FL.geom.kind).toBe('custom');
    expect(r.design.corners.FL.geom.custom).toEqual(e.custom);
    expect(r.warnings).toEqual([]);
  });
});

describe('custom linkage: sliding joints and optimizer points', () => {
  it('a MacPherson built from a lower arm, a top-mount body on a ball joint and a slider moves like the built-in one', async () => {
    const { SAMPLE_MACPHERSON: M } = await import('../src/examples/sampleLayouts');
    const top = M.damper!.chassis, lower = M.damper!.armPoint;
    const c: CustomLinkage = {
      bodies: [{ id: 'lca', name: 'Lower arm' }, { id: 'mount', name: 'Strut top mount' }],
      joints: [
        { id: 'h', kind: 'hinge', name: 'Arm pivot', a: 'chassis', b: 'lca', p: M.lca.fwd, q: M.lca.aft },
        { id: 'bj', kind: 'ball', name: 'Lower ball joint', a: 'lca', b: 'upright', p: M.lca.out },
        { id: 'tm', kind: 'ball', name: 'Top mount', a: 'chassis', b: 'mount', p: top },
        { id: 'st', kind: 'slider', name: 'Strut', a: 'mount', b: 'upright', p: lower, q: top },
        { id: 'tr', kind: 'rod', name: 'Tie rod', a: 'rack', b: 'upright', p: M.tieRod.inner, q: M.tieRod.outer },
      ],
      damperBody: 'upright',
    };
    expect(customProblems(c)).toEqual([]);
    const a = new DoubleWishbone(M).sweep(travels, (t) => ({ travel: t }));
    const b = new DoubleWishbone(custom({ ...M, damper: { ...M.damper!, arm: 'upright' } }, c)).sweep(travels, (t) => ({ travel: t }));
    a.forEach((s, i) => {
      expect(b[i]!.solve.status).toBe('converged');
      expect(characteristics(b[i]!).camber).toBeCloseTo(characteristics(s).camber, 7);
      expect(characteristics(b[i]!).toe).toBeCloseTo(characteristics(s).toe, 7);
    });
    // Slide and turn (4) in place of the slider leaves the mount free to spin: one motion too many.
    expect(customFreedom({ ...c, joints: c.joints.map((j) => (j.kind === 'slider' ? { ...j, kind: 'cylinder' as const } : j)) })).toBe(2);
  });

  it('the optimizer can move a joint point', async () => {
    const { withVariables, getPoint } = await import('../src/core/optimize/corner');
    const g = custom(C, customFromWishbone(C));
    expect(getPoint(g, 'custom:j3:p')).toEqual(C.uca.out);
    const moved = withVariables(g, [{ point: 'custom:j3:p', axis: 1, lo: 0, hi: 1000 }], [C.uca.out.y + 10]);
    expect(moved.custom!.joints.find((j) => j.id === 'j3')!.p.y).toBeCloseTo(C.uca.out.y + 10, 9);
    expect(new DoubleWishbone(moved).design().solve.status).toBe('converged');
    const { parseCustomVarKey, customVarKey } = await import('../src/app/optimizer');
    expect(parseCustomVarKey(customVarKey('j3', 'q', 2))).toEqual({ joint: 'j3', which: 'q', axis: 2 });
  });
});
