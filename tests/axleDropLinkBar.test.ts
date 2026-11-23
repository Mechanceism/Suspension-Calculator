/**
 * A torsion bar with drop links on a solid axle or twist beam acts through its mounts on the axle (or on the
 * arms), not at the wheel centers: both mounts move with both wheels' travels (axle table), and the bar's
 * force on each travel is −k θ / lever · (∂y_self/∂q_self − ∂y_other/∂q_self).
 */
import { describe, it, expect } from 'vitest';
import { assembleVehicle, solveCase, DEFAULT_MF, vec3, SolidAxle, solidAxleOf, AxleTable, type DoubleWishboneGeometry, type Vec3 } from '../src/core';
import { SAMPLE_LAYOUTS, SAMPLE_SPRING, SAMPLE_BEAM4, SAMPLE_TWIST_BEAM } from '../src/examples/sampleLayouts';

const C = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
const NONE = { kind: 'none' as const };
const barRate = 15e3 * (180 / Math.PI); // 15 N·m/deg in N·mm/rad (a light car: both rear tires stay loaded)
const lever = 250;

function car(rear: DoubleWishboneGeometry, rearBar: { antiRollBar: unknown }, dropLink: Vec3 | null) {
  const gas = { kind: 'gas' as const, volumeChange: true, volumeFactor: 1, conditions: { setPressure: 83, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 } };
  const d = (geometry: DoubleWishboneGeometry) => ({ geometry, profile: { radius: 260, width: 205, shoulderRadius: 25, rimRadius: 165 }, model: gas, springRate: SAMPLE_SPRING.rate, freeLength: SAMPLE_SPRING.freeLength, unsprungMass: 15 });
  return {
    designs: { FL: d(C), RL: d(rear) }, roots: { FL: 'FL', FR: 'FL', RL: 'RL', RR: 'RL' } as const,
    settings: { FL: { brake: 'outboard', drive: 'none' }, FR: { brake: 'outboard', drive: 'none' }, RL: { brake: 'outboard', drive: 'chassis' }, RR: { brake: 'outboard', drive: 'chassis' } } as const,
    mass: 300, cg: { x: 0, height: 280, z: -0.47 * 1550 }, wheelbase: 1550, brakeBias: 0.6, driveSplit: 0.5, autoPreload: true,
    shared: { front: { antiRollBar: NONE, heaveSpring: NONE }, rear: { ...rearBar, heaveSpring: NONE } },
    dropLinks: { front: null, rear: dropLink }, droop: 40, bump: 40, cases: { lateralG: 0, brakingG: 0, accelG: 0 }, goals: [], variables: [], tireGrip: DEFAULT_MF,
  };
}
const turn = (p: ReturnType<typeof car>, rear: DoubleWishboneGeometry) => {
  const asm = assembleVehicle(p as never, { FL: C, RL: rear })!;
  const r = solveCase(p as never, asm, { name: 't', kind: 'state', g: 0.6, lateralG: 0.6, brakingG: 0, accelG: 0 })!.result;
  expect(r.converged).toBe(true);
  expect(r.corners.RL.tireLoad).toBeGreaterThan(100); // not lifting a wheel (the bar's effect would saturate)
  return { roll: r.pose.roll, rearTransfer: r.corners.RR.tireLoad - r.corners.RL.tireLoad };
};

describe('drop-link anti-roll bar on one axle', () => {
  const wx = SAMPLE_BEAM4.wheel.center.x;

  it('the axle table tracks the mount on the axle: in roll it moves by its lateral distance, not the wheel\'s', () => {
    const mount = vec3(0.6 * wx, SAMPLE_BEAM4.wheel.center.y, SAMPLE_BEAM4.wheel.center.z);
    const t = new AxleTable(new SolidAxle(solidAxleOf(SAMPLE_BEAM4)), [-40, 40], 17, 0, mount);
    const a = t.at('L', 10, -10), a0 = t.at('L', 0, 0);
    expect(a0.ex.x).toBeCloseTo(mount.x, 6);
    // A symmetric 4-link rolls about the centerline: the mount rises 0.6 × the wheel's travel.
    expect(a.ex.y - a0.ex.y).toBeCloseTo(0.6 * 10, 1);
    // Its slopes: +0.8 / −0.2 of the own / other travel (rigid axle: (1 ± 0.6) / 2).
    expect(a.dex.y).toBeCloseTo(0.8, 2);
    expect(a.dexX.y).toBeCloseTo(0.2, 2);
    const r = t.at('R', -10, 10);
    expect(r.ex.y - a0.ex.y).toBeCloseTo(-6, 1); // the right mount (in its own frame) goes down as much
  });

  it('solid axle: a bar with mounts at 0.6 × the half track is the equivalent wheel-rate bar k·0.6²/lever²', () => {
    const mount = vec3(0.6 * wx, SAMPLE_BEAM4.wheel.center.y, SAMPLE_BEAM4.wheel.center.z);
    const tb = turn(car(SAMPLE_BEAM4, { antiRollBar: { kind: 'torsionBar', barRate, lever } }, mount), SAMPLE_BEAM4);
    const wr = turn(car(SAMPLE_BEAM4, { antiRollBar: { kind: 'wheelRate', rate: (barRate * 0.36) / lever ** 2 } }, null), SAMPLE_BEAM4);
    const none = turn(car(SAMPLE_BEAM4, { antiRollBar: NONE }, null), SAMPLE_BEAM4);
    // The bar adds rear roll stiffness: more transfer at the rear, less roll.
    expect(tb.rearTransfer).toBeGreaterThan(none.rearTransfer + 5); // (a high roll center: most goes through the links)
    expect(tb.roll).toBeCloseTo(wr.roll, 4);
    expect(tb.rearTransfer).toBeCloseTo(wr.rearTransfer, -1);
    // At the wheel centers (the old reading) it would be 1 / 0.36 as stiff: clearly different.
    const atWheels = turn(car(SAMPLE_BEAM4, { antiRollBar: { kind: 'wheelRate', rate: barRate / lever ** 2 } }, null), SAMPLE_BEAM4);
    expect(atWheels.rearTransfer - tb.rearTransfer).toBeGreaterThan(5);
    expect(atWheels.roll).toBeLessThan(tb.roll - 0.0003);
  });

  it('twist beam: mounts farther in give a softer bar', () => {
    const at = (f: number) => vec3(f * SAMPLE_TWIST_BEAM.lca.out.x, SAMPLE_TWIST_BEAM.lca.out.y, SAMPLE_TWIST_BEAM.lca.out.z);
    const out = turn(car(SAMPLE_TWIST_BEAM, { antiRollBar: { kind: 'torsionBar', barRate, lever } }, at(1)), SAMPLE_TWIST_BEAM);
    const inb = turn(car(SAMPLE_TWIST_BEAM, { antiRollBar: { kind: 'torsionBar', barRate, lever } }, at(0.5)), SAMPLE_TWIST_BEAM);
    const none = turn(car(SAMPLE_TWIST_BEAM, { antiRollBar: NONE }, null), SAMPLE_TWIST_BEAM);
    expect(out.rearTransfer).toBeGreaterThan(inb.rearTransfer + 3);
    expect(inb.rearTransfer).toBeGreaterThan(none.rearTransfer + 3);
    expect(out.roll).toBeLessThan(inb.roll);
  });
});
