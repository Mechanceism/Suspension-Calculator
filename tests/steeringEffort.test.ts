import { describe, it, expect } from 'vitest';
import {
  DoubleWishbone, characteristics, steeringEffort, steeringLoads, steeringArmLever, parkingTorque, steeringMechanism,
  sampleCorner, goalValue, cornerGoalResiduals, optimizeCorner, getPoint, normalize, sub, dot,
  type DoubleWishboneGeometry,
} from '../src/core';
import { SAMPLE_LAYOUTS } from '../src/examples/sampleLayouts';

const geom = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
const spec = { cFactor: 75, mu: 1, load: 1000, lateralG: 0.5, pneumaticTrail: 20 };

/** Move both ball joints (the steering axis) sideways by dx: the scrub radius changes by about dx. */
const shiftAxis = (g: DoubleWishboneGeometry, dx: number): DoubleWishboneGeometry => ({
  ...g,
  uca: { ...g.uca, out: { ...g.uca.out, x: g.uca.out.x + dx } },
  lca: { ...g.lca, out: { ...g.lca.out, x: g.lca.out.x + dx } },
});

describe('steering effort (virtual work through the steering kinematics)', () => {
  it('agrees with the force balance through the tie rod and rack (the Steering panel\'s numbers)', () => {
    const corner = new DoubleWishbone(geom);
    const st = corner.solve({ travel: 0 });
    const e = steeringEffort(corner, st, spec)!;
    const c = characteristics(st);
    // At speed: this corner's steering-wheel torque from the side force alone, both wheels.
    const l = steeringLoads(st, c.contactPoint, { vertical: 0, lateral: -spec.lateralG * spec.load, longitudinal: 0, pneumaticTrail: spec.pneumaticTrail }, steeringMechanism(corner), spec.cFactor);
    expect(e.atSpeed).toBeCloseTo(2 * Math.abs(l.steeringWheelTorque), 2);
    // Parking (rigid contact): the panel's T / lever × rack share → rack force → wheel torque.
    const u = normalize(sub(st.points.steerUpper, st.points.steerLower));
    const ground = { ...st.points.steerLower, x: st.points.steerLower.x + (u.x * (c.contactPoint.y - st.points.steerLower.y)) / u.y, y: c.contactPoint.y, z: st.points.steerLower.z + (u.z * (c.contactPoint.y - st.points.steerLower.y)) / u.y };
    const park = parkingTorque({ points: [c.contactPoint], weights: [1] }, ground, spec.load, spec.mu);
    const share = Math.abs(dot(normalize(sub(st.points.trInner, st.points.trOuter)), corner.rackAxis));
    const rack = (park / Math.abs(steeringArmLever(st))) * share;
    expect(e.parking).toBeCloseTo((2 * rack * spec.cFactor) / (2 * Math.PI) / 1000, 2);
    expect(e.parking).toBeGreaterThan(0);
  });

  it('scales with the load, the lateral g and the steering ratio; grows with the scrub radius', () => {
    const corner = new DoubleWishbone(geom);
    const st = corner.solve({ travel: 0 });
    const e = steeringEffort(corner, st, spec)!;
    expect(steeringEffort(corner, st, { ...spec, lateralG: 1 })!.atSpeed).toBeCloseTo(2 * e.atSpeed, 6);
    expect(steeringEffort(corner, st, { ...spec, load: 2000 })!.parking).toBeCloseTo(2 * e.parking, 6);
    // A slower steering (less rack per turn) needs less torque: T_sw ∝ c.
    expect(steeringEffort(corner, st, { ...spec, cFactor: 37.5 })!.parking).toBeCloseTo(e.parking / 2, 6);
    expect(steeringEffort(corner, st, { ...spec, lateralG: 0 })!.atSpeed).toBe(0);
    // The scrub radius from moving the steering axis: parking effort follows its size.
    const efforts = [-40, -20, 0, 20].map((dx) => {
      const g = shiftAxis(geom, dx);
      const s = sampleCorner(g, { droop: 0, bump: 0, goals: [{ kind: 'parkingEffort', target: 0, weight: 1 }], steering: spec })!;
      return { scrub: Math.abs(s.chars[s.i0]!.scrubRadius), parking: goalValue('parkingEffort', s)! };
    }).sort((a, b) => a.scrub - b.scrub);
    for (let i = 1; i < efforts.length; i++) expect(efforts[i]!.parking).toBeGreaterThan(efforts[i - 1]!.parking);
  });

  it('limit goals count only above the limit; the corner optimizer brings scrub and effort under them', () => {
    const s = sampleCorner(geom, { droop: 0, bump: 0, goals: [{ kind: 'scrubLimit', target: 0, weight: 1 }, { kind: 'parkingEffort', target: 0, weight: 1 }], steering: spec })!;
    const scrub = Math.abs(s.chars[s.i0]!.scrubRadius);
    expect(goalValue('scrubLimit', s)).toBeCloseTo(scrub, 9);
    expect(cornerGoalResiduals({ kind: 'scrubLimit', target: scrub + 5, weight: 1 }, s)).toEqual([0]);
    expect(cornerGoalResiduals({ kind: 'scrubLimit', target: scrub - 5, weight: 1 }, s)[0]).toBeCloseTo(5, 6);
    // No steering spec: the effort goals don't apply (no residual), they don't block.
    const noSteer = sampleCorner(geom, { droop: 0, bump: 0, goals: [{ kind: 'parkingEffort', target: 0, weight: 1 }] })!;
    expect(cornerGoalResiduals({ kind: 'parkingEffort', target: 1, weight: 1 }, noSteer)).toEqual([]);

    // Start from a big scrub radius (axis moved 40 mm inboard); free the ball joints' X.
    const wide = shiftAxis(geom, -40);
    const s0 = sampleCorner(wide, { droop: 0, bump: 0, goals: [{ kind: 'parkingEffort', target: 0, weight: 1 }], steering: spec })!;
    const scrub0 = Math.abs(s0.chars[s0.i0]!.scrubRadius), park0 = goalValue('parkingEffort', s0)!;
    expect(scrub0).toBeGreaterThan(40);
    const vars = (['ucaOut', 'lcaOut'] as const).map((k) => { const v = getPoint(wide, k)!; return { point: k, axis: 0 as const, lo: v.x - 60, hi: v.x + 60 }; });
    const r = optimizeCorner({ geometry: wide, droop: -30, bump: 30, steering: spec, variables: vars, keepClose: 0.01,
      goals: [{ kind: 'scrubLimit', target: 20, weight: 1 }, { kind: 'parkingEffort', target: 0.8 * park0, weight: 1 }] });
    const s1 = sampleCorner(r.geometry, { droop: 0, bump: 0, goals: [{ kind: 'parkingEffort', target: 0, weight: 1 }], steering: spec })!;
    expect(Math.abs(s1.chars[s1.i0]!.scrubRadius)).toBeLessThan(20 + 1);
    expect(goalValue('parkingEffort', s1)!).toBeLessThan(0.8 * park0 + 0.5);
  });

  it('the vehicle optimizer reports the heaviest steered design', async () => {
    const { buildVehicleProblem } = await import('../src/app/optimizer');
    const { defaultDesign, defaultVehicleOptimizerSetup } = await import('../src/app/store');
    const { evaluateVehicle, vehicleGoalValue } = await import('../src/core');
    const d = defaultDesign();
    const vo = defaultVehicleOptimizerSetup();
    vo.goals.parkingEffort.on = true;
    vo.goals.scrubLimit.on = true;
    const { problem } = buildVehicleProblem({ ...d, vehicleOptimizer: vo } as never);
    // Only the steered (front) design gets steering inputs.
    expect(Object.keys(problem.effort ?? {})).toEqual(['FL']);
    const p = { ...problem, cases: { lateralG: 0.8, brakingG: 0, accelG: 0 }, states: undefined };
    const geoms = Object.fromEntries(Object.entries(p.designs).map(([k, v]) => [k, v!.geometry]));
    const e = evaluateVehicle(p, geoms)!;
    const front = sampleCorner(geoms.FL!, { droop: 0, bump: 0, goals: [{ kind: 'parkingEffort', target: 0, weight: 1 }], steering: { ...problem.effort!.FL!, tire: { profile: p.designs.FL!.profile, model: p.designs.FL!.model } } })!;
    expect(vehicleGoalValue('parkingEffort', p, e)).toBeCloseTo(goalValue('parkingEffort', front)!, 9);
    expect(vehicleGoalValue('scrubLimit', p, e)).toBeCloseTo(Math.abs(front.chars[front.i0]!.scrubRadius), 9);
  });
});
