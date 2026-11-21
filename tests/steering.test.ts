import { describe, it, expect } from 'vitest';
import {
  DoubleWishbone, characteristics, headingAngle, lowerArmAngle, steeringLoads, steeringArmLever,
  parkingTorque, patchSamples, spinAxisFromCamberToe, damperTravelLimits, springLength, springForce,
  vec3, rad, deg, X_AXIS, type DoubleWishboneGeometry, type TireProfile,
} from '../src/core';
import { SAMPLE_LAYOUTS } from '../src/examples/sampleLayouts';

/** Vertical steering axis at x = 575 (zero KPI and caster), 25 mm scrub, 120 mm steering arm behind. */
const vertical: DoubleWishboneGeometry = {
  uca: { fwd: vec3(250, 300, 150), aft: vec3(250, 300, -150), out: vec3(575, 320, 0) },
  lca: { fwd: vec3(200, 45, 150), aft: vec3(200, 45, -150), out: vec3(575, 40, 0) },
  tieRod: { inner: vec3(200, 100, -120), outer: vec3(540, 100, -120) },
  wheel: { center: vec3(600, 160, 0), spinAxis: vec3(1, 0, 0), radius: 260 },
};

describe('heading and arm angle', () => {
  it('heading is + when the front of the wheel points outboard', () => {
    expect(headingAngle(X_AXIS)).toBeCloseTo(0, 12);
    expect(deg(headingAngle(spinAxisFromCamberToe(0, rad(-2))))).toBeCloseTo(2, 9); // toe-out = +heading
  });
  it('lower arm angle matches the driven angle', () => {
    const corner = new DoubleWishbone(vertical);
    const s = corner.solve({ driver: 'lowerArmAngle', armAngle: rad(4) });
    expect(deg(lowerArmAngle(vertical, s))).toBeCloseTo(4, 8);
  });
});

describe('steering loads (vertical axis, hand-checkable)', () => {
  const state = new DoubleWishbone(vertical).design();
  const contact = vec3(600, -100, 0);
  it('steering-arm lever is the 120 mm arm behind the axis', () => {
    expect(steeringArmLever(state)).toBeCloseTo(120, 9);
  });
  it('braking force × scrub radius → axis torque, tie-rod, rack and wheel torque', () => {
    const r = steeringLoads(state, contact, { vertical: 1000, lateral: 0, longitudinal: -1000, pneumaticTrail: 0 }, X_AXIS, 75);
    expect(r.axisTorque).toBeCloseTo(25 * 1000, 6); // positive scrub + braking → toe-out tendency
    expect(r.tieRodForce).toBeCloseTo(-25000 / 120, 6);
    expect(r.rackForce).toBeCloseTo(25000 / 120, 6);
    expect(r.steeringWheelTorque).toBeCloseTo(((25000 / 120) * 75) / (2 * Math.PI) / 1000, 9);
  });
  it('vertical load has no torque about a vertical axis; lateral force acts through pneumatic trail', () => {
    expect(steeringLoads(state, contact, { vertical: 5000, lateral: 0, longitudinal: 0, pneumaticTrail: 0 }, X_AXIS, 75).axisTorque).toBeCloseTo(0, 6);
    const lat = steeringLoads(state, contact, { vertical: 0, lateral: -1000, longitudinal: 0, pneumaticTrail: 30 }, X_AXIS, 75);
    expect(lat.axisTorque).toBeCloseTo(30 * 1000, 6);
  });
  it('KPI makes vertical load produce a returning torque once steered', () => {
    const corner = new DoubleWishbone(SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry);
    const straight = corner.design();
    const c0 = characteristics(straight);
    const t0 = steeringLoads(straight, c0.contactPoint, { vertical: 1000, lateral: 0, longitudinal: 0, pneumaticTrail: 0 }, X_AXIS, 75).axisTorque;
    expect(t0).toBeCloseTo(0, 6);
    const steered = corner.solve({ driver: 'lowerArmAngle', armAngle: 0, rack: 15 });
    const c1 = characteristics(steered);
    const t1 = steeringLoads(steered, c1.contactPoint, { vertical: 1000, lateral: 0, longitudinal: 0, pneumaticTrail: 0 }, X_AXIS, 75).axisTorque;
    const steer = headingAngle(steered.spinAxis) - headingAngle(straight.spinAxis);
    // Torque opposes the steer direction (self-centering from KPI jacking).
    expect(Math.sign(t1)).toBe(-Math.sign(steer));
  });
});

describe('parking scrub torque', () => {
  const profile: TireProfile = { radius: 260, width: 205, shoulderRadius: 0, rimRadius: 165 };
  const ground = { point: vec3(0, -100, 0), normal: vec3(0, 1, 0) };
  const samples = patchSamples(vec3(600, 150, 0), X_AXIS, ground, profile);
  it('sample weights add up to the patch area', () => {
    const area = samples.weights.reduce((a, b) => a + b, 0);
    expect(area).toBeCloseTo(205 * 2 * Math.sqrt(260 ** 2 - 250 ** 2), 0);
  });
  it('approaches μ·F·distance when the axis is far from the patch', () => {
    const T = parkingTorque(samples, vec3(2600, -100, 0), 1000, 1);
    expect(T / (1000 * 2000)).toBeCloseTo(1, 2);
  });
  it('grows with scrub radius and is smallest with the axis at the patch center', () => {
    const at = (x: number) => parkingTorque(samples, vec3(x, -100, 0), 1000, 1);
    expect(at(600)).toBeLessThan(at(575));
    expect(at(575)).toBeLessThan(at(550));
    // Square-ish check: for a W × L rectangle the mean distance from the center is below the half-diagonal.
    expect(at(600) / 1000).toBeLessThan(Math.hypot(102.5, 71.4));
  });
});

describe('damper travel limits and bump stop', () => {
  const geom = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
  const corner = new DoubleWishbone(geom);
  const L0 = springLength(corner.design())!;
  it('finds the travel where the damper reaches its extended and compressed lengths', () => {
    const lim = damperTravelLimits(corner, L0 - 30, L0 + 25);
    expect(lim.bump).not.toBeNull();
    expect(lim.droop).not.toBeNull();
    expect(springLength(corner.solve({ travel: lim.bump! }))!).toBeCloseTo(L0 - 30, 3);
    expect(springLength(corner.solve({ travel: lim.droop! }))!).toBeCloseTo(L0 + 25, 3);
    expect(lim.bump!).toBeGreaterThan(0);
    expect(lim.droop!).toBeLessThan(0);
  });
  it('bump stop adds force only once engaged', () => {
    const spec = { rate: 60, freeLength: 400, bumpStopLength: 370, bumpStopRate: 300 };
    expect(springForce(spec, 380)).toBeCloseTo(60 * 20, 9);
    expect(springForce(spec, 360)).toBeCloseTo(60 * 40 + 300 * 10, 9);
  });
});
