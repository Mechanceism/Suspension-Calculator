import { describe, it, expect } from 'vitest';
import {
  TwistBeam, DoubleWishbone, characteristics, axleCharacteristics, SolidAxle, solidAxleOf, assembleVehicle, solveCase, DEFAULT_MF,
  vec3, type DoubleWishboneGeometry,
} from '../src/core';
import { SAMPLE_LAYOUTS, SAMPLE_SPRING, SAMPLE_TWIST_BEAM, SAMPLE_LEAF } from '../src/examples/sampleLayouts';

const C = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
const camberOf = (s: { spinAxis: { y: number } }) => Math.asin(-s.spinAxis.y);
const toeOf = (s: { spinAxis: { x: number; z: number } }) => Math.atan2(s.spinAxis.z, s.spinAxis.x);

/** A small car with C in front and the given rear design (its own corner root). */
function car(rear: DoubleWishboneGeometry, arb = 0) {
  const gas = { kind: 'gas' as const, volumeChange: true, volumeFactor: 1, conditions: { setPressure: 83, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 } };
  const d = (geometry: DoubleWishboneGeometry) => ({ geometry, profile: { radius: 260, width: 205, shoulderRadius: 25, rimRadius: 165 }, model: gas, springRate: SAMPLE_SPRING.rate, freeLength: SAMPLE_SPRING.freeLength, unsprungMass: 15 });
  return {
    designs: { FL: d(C), RL: d(rear) }, roots: { FL: 'FL', FR: 'FL', RL: 'RL', RR: 'RL' } as const,
    settings: { FL: { brake: 'outboard', drive: 'none' }, FR: { brake: 'outboard', drive: 'none' }, RL: { brake: 'outboard', drive: 'chassis' }, RR: { brake: 'outboard', drive: 'chassis' } } as const,
    mass: 300, cg: { x: 0, height: 280, z: -0.47 * 1550 }, wheelbase: 1550, brakeBias: 0.6, driveSplit: 0.5, autoPreload: true,
    shared: { front: { antiRollBar: { kind: 'none' as const }, heaveSpring: { kind: 'none' as const } }, rear: { antiRollBar: arb ? { kind: 'wheelRate' as const, rate: arb } : { kind: 'none' as const }, heaveSpring: { kind: 'none' as const } } },
    dropLinks: { front: null, rear: null }, droop: 40, bump: 40, cases: { lateralG: 0, brakingG: 0, accelG: 0 }, goals: [], variables: [], tireGrip: DEFAULT_MF,
  };
}

describe('twist beam', () => {
  const tb = new TwistBeam({ kind: 'twistBeam', wheel: SAMPLE_TWIST_BEAM.wheel, bushing: SAMPLE_TWIST_BEAM.lca.fwd, shearCenter: SAMPLE_TWIST_BEAM.lca.aft });
  it('reaches any pair of travels; heave is a plain trailing arm, roll turns each arm about bushing → shear center', () => {
    for (const [l, r] of [[0, 0], [40, 40], [-40, -40], [30, -30], [-20, 35]]) {
      const s = tb.solve({ left: l, right: r });
      expect(s.solve.status).toBe('converged');
      expect(s.left.center.y).toBeCloseTo(160 + l!, 6);
      expect(s.right.center.y).toBeCloseTo(160 + r!, 6);
    }
    const heave = tb.solve({ left: 40, right: 40 });
    expect(camberOf(heave.left)).toBeCloseTo(0, 9);
    expect(toeOf(heave.left)).toBeCloseTo(0, 9);
    // In heave the shear center swings with the arms about the bushing line.
    expect(heave.twist!.shearCenter.y).toBeGreaterThan(100);
    // Roll: the shear center (on the centerline) stays put; the wheels camber and steer.
    const roll = tb.solve({ left: 30, right: -30 });
    expect(roll.twist!.shearCenter.y).toBeCloseTo(100, 0); // (only the small second-order heave that keeps the travels exact)
    expect(Math.abs(camberOf(roll.left))).toBeGreaterThan(0.005);
    expect(camberOf(roll.left)).toBeCloseTo(-camberOf(roll.right), 5); // mirrored (to the small second-order heave)
    expect(Math.abs(toeOf(roll.left))).toBeLessThan(0.002); // a level roll axis: little roll steer
  });

  it('with the shear center level with the bushings it is a pair of trailing arms (no roll camber)', () => {
    const ta = new TwistBeam({ kind: 'twistBeam', wheel: SAMPLE_TWIST_BEAM.wheel, bushing: SAMPLE_TWIST_BEAM.lca.fwd, shearCenter: vec3(0, 100, 450) });
    const roll = ta.solve({ left: 30, right: -30 });
    expect(camberOf(roll.left)).toBeCloseTo(0, 9);
    expect(toeOf(roll.left)).toBeCloseTo(0, 9);
  });

  it('as a corner: no camber change in heave, roll center from the roll axis, side-view IC at the bushing', () => {
    const c = new DoubleWishbone(SAMPLE_TWIST_BEAM);
    expect(c.twistBeam).not.toBeNull();
    const states = c.sweep([-40, 0, 40], (t) => ({ travel: t }));
    expect(states.every((s) => s.solve.status === 'converged')).toBe(true);
    expect(characteristics(states[2]!).camber).toBeCloseTo(characteristics(states[1]!).camber, 9);
    const ch = characteristics(states[1]!);
    // Roll axis bushing (480, 100, 450) → shear center (0, 100, 300) meets the wheel's plane at (−960, 100):
    // the line from the contact (600, −100) through it crosses the centerline 200·600/1560 above the ground.
    expect(ch.rollCenterHeight!).toBeCloseTo((200 * 600) / 1560, 3);
    expect(ch.svsa).toBeCloseTo(ch.contactPoint.z - 450, 6);
    expect(characteristics(states[2]!).damperLength!).toBeLessThan(ch.damperLength!);
  });

  it('a car with a twist-beam rear couples the two rear wheels and corners', () => {
    const p = car(SAMPLE_TWIST_BEAM, 15);
    const asm = assembleVehicle(p as never, { FL: C, RL: SAMPLE_TWIST_BEAM })!;
    expect(asm).not.toBeNull();
    expect(asm.corners.find((x) => x.id === 'RL')!.axle).toBeDefined();
    const rest = solveCase(p as never, asm, { name: 'r', kind: 'state', g: 0, lateralG: 0, brakingG: 0, accelG: 0 })!.result;
    expect(rest.converged).toBe(true);
    for (const id of ['RL', 'RR'] as const) expect(Math.abs(rest.corners[id].travel)).toBeLessThan(1.5);
    const turn = solveCase(p as never, asm, { name: 't', kind: 'state', g: 0.6, lateralG: 0.6, brakingG: 0, accelG: 0 })!.result;
    expect(turn.converged).toBe(true);
    expect(turn.corners.RR.tireLoad).toBeGreaterThan(turn.corners.RL.tireLoad);
  });
});

describe('solid axle on leaf springs', () => {
  it('the leaf locates the axle: roll center ≈ seat height, the seat swings on the ¾ arc, the leaf rate acts at the seat', () => {
    const g = solidAxleOf(SAMPLE_LEAF);
    expect(g.links).toHaveLength(4);
    const axle = new SolidAxle(g);
    const s0 = axle.design();
    expect(s0.solve.status).toBe('converged');
    const ac = axleCharacteristics(axle, s0);
    expect(ac.rollCenterHeight!).toBeCloseTo(280, -1); // seat at y = 180, ground at −100
    // Parallel equivalent links: the axle keeps its pitch in heave (no wind-up from the kinematics).
    expect(Math.abs(ac.windUp)).toBeLessThan(1e-3);
    const s1 = axle.solve({ left: 30, right: 30 });
    expect(s1.solve.status).toBe('converged');
    expect(s1.springLength!.left).toBeCloseTo(s0.springLength!.left - 30, 0);
  });

  it('as a design type: the corner heaves the axle; a car with it at the rear settles and corners', () => {
    const c = new DoubleWishbone(SAMPLE_LEAF);
    const s0 = c.design(), s1 = c.solve({ travel: 25 });
    expect(s1.solve.status).toBe('converged');
    expect(s1.points.axleRight!.y).toBeCloseTo(185, 6);
    expect(s0.points.leafEye).toEqual(SAMPLE_LEAF.lca.fwd);
    expect(characteristics(s0).rollCenterHeight!).toBeCloseTo(280, -1);
    const p = car(SAMPLE_LEAF);
    const asm = assembleVehicle(p as never, { FL: C, RL: SAMPLE_LEAF })!;
    expect(asm).not.toBeNull();
    const r = solveCase(p as never, asm, { name: 't', kind: 'state', g: 0.6, lateralG: 0.6, brakingG: 0, accelG: 0 })!.result;
    expect(r.converged).toBe(true);
  });
});

describe('twist beam and leaf springs in the app', () => {
  it('switching a design builds working geometry; presets solve; back again works', async () => {
    const { editableFromLayout, convertGeometry, toGeometry, activePointKeys } = await import('../src/app/store');
    const dw = editableFromLayout('C');
    for (const kind of ['twistBeam', 'beamLeaf'] as const) {
      const e = convertGeometry(dw, kind);
      const c = new DoubleWishbone(toGeometry(e));
      expect(c.sweep([-30, 0, 30], (t) => ({ travel: t })).every((s) => s.solve.status === 'converged')).toBe(true);
      const back = toGeometry(convertGeometry(e, 'doubleWishbone'));
      expect(new DoubleWishbone(back).design().solve.status).toBe('converged');
    }
    expect(activePointKeys('twistBeam')).toContain('lcaAft');
    expect(activePointKeys('beamLeaf')).not.toContain('dmpChassis');
    for (const id of ['TB', 'LF']) expect(new DoubleWishbone(toGeometry(editableFromLayout(id))).design().solve.status).toBe('converged');
  });
});
