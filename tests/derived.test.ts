import { describe, it, expect } from 'vitest';
import { rollCamber, ackermann, rollStiffness, DoubleWishbone, headingAngle, characteristics } from '../src/core';
import { SAMPLE_LAYOUTS } from '../src/examples/sampleLayouts';

const D = Math.PI / 180;

describe('derived variables', () => {
  it('roll camber: 1 + camber gain · half track (deg/deg)', () => {
    expect(rollCamber(-0.0286, 600)).toBeCloseTo(1 - 0.0286 * D * 600, 9);
    expect(rollCamber(0, 600)).toBe(1); // no camber gain: the wheel leans with the body
    // A gain of −1/half track (rad/mm) keeps the outside wheel upright to the ground, like a solid axle.
    expect(rollCamber(-1 / D / 600, 600)).toBeCloseTo(0, 9);
  });

  it('Ackermann: ideal = 100 %, parallel = 0 %, anti < 0; either turn direction', () => {
    const L = 1550, T = 1200, out = 20 * D;
    const ideal = Math.atan(L / (L / Math.tan(out) - T));
    expect(ackermann(ideal, out, L, T).percent).toBeCloseTo(100, 6);
    expect(ackermann(-out, -ideal, L, T).percent).toBeCloseTo(100, 6); // right turn: the right wheel is inside
    expect(ackermann(out, out, L, T).percent).toBeCloseTo(0, 9);
    expect(ackermann(0.9 * out, out, L, T).percent).toBeLessThan(0);
    expect(Number.isNaN(ackermann(0, 0, L, T).percent)).toBe(true);
    // Ideal geometry: cot δo − cot δi = T / L.
    expect(1 / Math.tan(out) - 1 / Math.tan(ideal)).toBeCloseTo(T / L, 9);
  });

  it('Ackermann of a real corner with its mirror: the same either way and finite', () => {
    const c = new DoubleWishbone(SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry);
    const h0 = headingAngle(c.solve({}).spinAxis);
    const yaw = (r: number) => headingAngle(c.solve({ rack: r }).spinAxis) - h0;
    const g = characteristics(c.solve({})).steeringAxisAtGround!;
    const left = ackermann(yaw(20), -yaw(-20), 1550, 2 * Math.abs(g.x));
    const right = ackermann(yaw(-20), -yaw(20), 1550, 2 * Math.abs(g.x));
    expect(Number.isFinite(left.percent)).toBe(true);
    expect(right.percent).toBeCloseTo(left.percent, 9);
    expect(left.inside).toBeGreaterThan(0);
  });

  it('roll stiffness: spring-path transfer × track ÷ roll', () => {
    expect(rollStiffness(1000, 1200, 1)).toBeCloseTo(1200, 9);
    expect(rollStiffness(-1000, 1200, -2)).toBeCloseTo(600, 9);
    expect(Number.isNaN(rollStiffness(1000, 1200, 0))).toBe(true);
  });
});

describe('roll stiffness from the whole-car solve', () => {
  it('matches wheel rate (in series with the tire) × track² / 2 per axle', async () => {
    const { buildVehicleProblem } = await import('../src/app/optimizer');
    const { defaultDesign } = await import('../src/app/store');
    const { assembleVehicle, solveCase, tireRate } = await import('../src/core');
    const { problem } = buildVehicleProblem(defaultDesign() as never);
    const geoms = Object.fromEntries(Object.entries(problem.designs).map(([k, v]) => [k, v!.geometry]));
    const asm = assembleVehicle(problem, geoms)!;
    const r0 = solveCase(problem, asm, { name: 'a', kind: 'state', g: 0, lateralG: 0, brakingG: 0, accelG: 0 })!.result;
    const r1 = solveCase(problem, asm, { name: 'b', kind: 'state', g: 0.5, lateralG: 0.5, brakingG: 0, accelG: 0 })!.result;
    const c = r1.corners;
    const track = c.FL.contact.x - c.FR.contact.x;
    const total = (c.FR.tireLoad - c.FL.tireLoad) / 2;
    const lateral = Math.abs(c.FL.lateralForce + c.FR.lateralForce);
    const rcH = characteristics(new DoubleWishbone(geoms.FL!).solve({})).rollCenterHeight!;
    const K = rollStiffness(total - (lateral * rcH) / track, track, (r1.pose.roll * 180) / Math.PI);
    const mr = Math.abs(asm.corners[0]!.table.at(0).dL);
    const kw = problem.designs.FL!.springRate * mr * mr;
    const d = problem.designs.FL!;
    const kt = tireRate(d.model, d.profile, 0, r0.corners.FL.tireLoad);
    const kr = (kw * kt) / (kw + kt);
    const expected = (kr * track * track) / 2 / 1000 * D; // N·m per degree
    expect(K / expected).toBeGreaterThan(0.9);
    expect(K / expected).toBeLessThan(1.1);
  });
});

describe('rack ahead of / behind the axle', () => {
  it('mirrors the steering arm through the steering axis: same Ackermann line, tie rod kept, reversible', async () => {
    const { editableFromLayout, flipRackSide, rackAhead, toGeometry } = await import('../src/app/store');
    const e = editableFromLayout('C');
    expect(rackAhead(e)).toBe(false);
    const f = flipRackSide(e);
    expect(rackAhead(f)).toBe(true);
    const len = (x: typeof e) => Math.hypot(...([0, 1, 2] as const).map((i) => x.points.trOuter[i].value - x.points.trInner[i].value));
    expect(len(f)).toBeCloseTo(len(e), 9);
    const back = flipRackSide(f);
    for (const k of ['trInner', 'trOuter'] as const) for (const i of [0, 1, 2]) expect(back.points[k][i]!.value).toBeCloseTo(e.points[k][i]!.value, 6);
    // Ackermann keeps its sign (the arm lies on the same line through the steering axis).
    const ack = (x: typeof e) => {
      const c = new DoubleWishbone(toGeometry(x));
      const h0 = headingAngle(c.solve({}).spinAxis);
      // Find the rack travel that turns the wheel 15° toward outboard, either direction of rack.
      const yaw = (r: number) => headingAngle(c.solve({ rack: r }).spinAxis) - h0;
      const r = Math.sign(yaw(5)) * 25;
      return ackermann(yaw(r), -yaw(-r), 1550, 1100).percent;
    };
    const a0 = ack(e), a1 = ack(f);
    expect(Math.sign(a1)).toBe(Math.sign(a0));
  });
});

describe('Ackermann lines', () => {
  it('cross on the centerline; parallel arms never cross', async () => {
    const { ackermannLinesCross } = await import('../src/core');
    // Arms pointing back and inward toward (0, −1550).
    const kL = { x: 550, z: 0 }, kR = { x: -550, z: 0 };
    const towards = (k: { x: number; z: number }) => ({ x: k.x + (0 - k.x) * 0.08, z: k.z + (-1550 - k.z) * 0.08 });
    const c = ackermannLinesCross(kL, towards(kL), kR, towards(kR))!;
    expect(c.x).toBeCloseTo(0, 9);
    expect(c.z).toBeCloseTo(-1550, 6);
    expect(ackermannLinesCross(kL, { x: 550, z: -100 }, kR, { x: -550, z: -100 })).toBeNull();
  });
});
