import { describe, it, expect } from 'vitest';
import {
  armMetrics, setArmLength, setPivotInclination, setPivotPlanAngle, transferArmPoint,
  vec3, distance, rad, deg, type ArmPoints,
} from '../src/core';

const arm: ArmPoints = { fwd: vec3(250, 280, 150), aft: vec3(250, 280, -150), out: vec3(530, 320, 0) };

describe('arm metrics', () => {
  it('measures legs, length and angles', () => {
    const m = armMetrics(arm);
    expect(m.frontLeg).toBeCloseTo(Math.hypot(280, 40, 150), 9);
    expect(m.length).toBeCloseTo(Math.hypot(280, 40), 9);
    expect(m.pivotSpacing).toBeCloseTo(300, 9);
    expect(m.inclination).toBeCloseTo(0, 12);
    expect(m.planAngle).toBeCloseTo(0, 12);
    expect(deg(m.frontViewAngle)).toBeCloseTo(deg(Math.atan2(40, 280)), 9);
  });
  it('reports inclination with + = front pivot higher', () => {
    const tilted = { ...arm, fwd: vec3(250, 290, 150), aft: vec3(250, 270, -150) };
    expect(deg(armMetrics(tilted).inclination)).toBeCloseTo(deg(Math.atan2(20, 300)), 9);
  });
});

describe('editing derived arm variables moves only the frame pivots', () => {
  it('length', () => {
    const a = setArmLength(arm, 350);
    expect(armMetrics(a).length).toBeCloseTo(350, 9);
    expect(a.out).toEqual(arm.out);
    expect(distance(a.fwd, a.aft)).toBeCloseTo(300, 9);
  });
  it('inclination', () => {
    const a = setPivotInclination(arm, rad(4));
    expect(deg(armMetrics(a).inclination)).toBeCloseTo(4, 9);
    expect(a.out).toEqual(arm.out);
    expect(armMetrics(a).length).toBeCloseTo(armMetrics(arm).length, 6);
  });
  it('plan angle', () => {
    const a = setPivotPlanAngle(arm, rad(-3));
    expect(deg(armMetrics(a).planAngle)).toBeCloseTo(-3, 9);
    expect(a.out).toEqual(arm.out);
    expect(armMetrics(a).length).toBeCloseTo(armMetrics(arm).length, 9);
    expect(armMetrics(a).pivotSpacing).toBeCloseTo(300, 9);
  });
  it('inclination and plan angle are independent', () => {
    const a = setPivotPlanAngle(setPivotInclination(arm, rad(3)), rad(2));
    expect(deg(armMetrics(a).inclination)).toBeCloseTo(3, 9);
    expect(deg(armMetrics(a).planAngle)).toBeCloseTo(2, 9);
  });
});

describe('transferArmPoint', () => {
  it('maps a point to the same relative position on another arm', () => {
    const lca: ArmPoints = { fwd: vec3(200, 45, 150), aft: vec3(200, 45, -150), out: vec3(560, 40, 0) };
    // 80% of the way to the ball joint on the LCA, 30 mm forward.
    const mLca = armMetrics(lca);
    const p = vec3(mLca.foot.x + 0.8 * (lca.out.x - mLca.foot.x), mLca.foot.y + 0.8 * (lca.out.y - mLca.foot.y), 30);
    const q = transferArmPoint(p, lca, arm);
    const mUca = armMetrics(arm);
    expect(q.z).toBeCloseTo(30, 6);
    expect(distance(q, vec3(q.x, q.y, 0))).toBeCloseTo(30, 6);
    expect((q.x - mUca.foot.x) / (arm.out.x - mUca.foot.x)).toBeCloseTo(0.8, 6);
    // Round trip
    const back = transferArmPoint(q, arm, lca);
    expect(distance(back, p)).toBeLessThan(1e-9);
  });
});
