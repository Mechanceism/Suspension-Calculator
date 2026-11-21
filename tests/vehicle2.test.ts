import { describe, it, expect } from 'vitest';
import {
  DoubleWishbone, CornerTable, solveVehicle, staticCornerLoads, fitFreeLength, designGroundY, characteristics,
  setPivotInclination, CORNER_IDS, isFront, vec3, rad,
  type VehicleInput, type TireForceModel, type DoubleWishboneGeometry, type AxleShared, type BrakeMount, type TrackedPoint, type DriveMount,
} from '../src/core';
import { SAMPLE_LAYOUTS, SAMPLE_SPRING } from '../src/examples/sampleLayouts';

const G = 9.80665;
const base = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
const profile = { radius: 260, width: 205, shoulderRadius: 25, rimRadius: 165 };
const gas: TireForceModel = {
  kind: 'gas', volumeChange: true, volumeFactor: 1,
  conditions: { setPressure: 83, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 },
};
const WB = 1550;
const MASS = 300;
const MU = 12;
const CG = vec3(0, 280, -0.47 * WB);
const NONE: AxleShared = { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } };
const DROP_LINK: TrackedPoint = { body: 'lca', point: vec3(450, 41.5, 60) };

function car(opts: {
  front?: DoubleWishboneGeometry; rear?: DoubleWishboneGeometry; lateralG?: number; brakingG?: number; brake?: BrakeMount;
  accelG?: number; rearDrive?: DriveMount;
  shared?: { front: AxleShared; rear: AxleShared }; track?: TrackedPoint;
} = {}): VehicleInput {
  const fGeom = opts.front ?? base;
  const cF = new DoubleWishbone(fGeom);
  const cR = new DoubleWishbone(opts.rear ?? base);
  const cx = cF.design().points.contact.x;
  const loads = staticCornerLoads(MASS, CG, WB, { FL: cx, FR: cx, RL: cx, RR: cx });
  const tF = new CornerTable(cF, 0, [-50, 50], 41, opts.track);
  const tR = new CornerTable(cR, 0, [-50, 50], 41, opts.track);
  const contactY = cF.design().points.contact.y;
  const groundY = designGroundY(CORNER_IDS.map((id) => ({ contactY, profile, model: gas, staticLoad: loads[id], tilt: 0 })));
  return {
    totalMass: MASS, cg: vec3(CG.x, groundY + CG.y, CG.z), wheelbase: WB, groundY,
    lateralG: opts.lateralG ?? 0, brakingG: opts.brakingG ?? 0, brakeBias: 0.6, shared: opts.shared,
    accelG: opts.accelG ?? 0, driveSplit: 0,
    corners: CORNER_IDS.map((id) => {
      const corner = isFront(id) ? cF : cR;
      return {
        id, table: isFront(id) ? tF : tR, unsprungMass: MU, tire: { profile, model: gas }, brake: opts.brake ?? 'outboard',
        drive: isFront(id) ? 'none' : (opts.rearDrive ?? 'none'),
        spring: { rate: SAMPLE_SPRING.rate, freeLength: fitFreeLength(corner, SAMPLE_SPRING.rate, loads[id] - MU * G) },
      };
    }),
  };
}

const sumLoad = (r: ReturnType<typeof solveVehicle>, ids: readonly string[]) =>
  ids.reduce((s, id) => s + r.corners[id as 'FL'].tireLoad, 0);

describe('braking', () => {
  it('dives the nose, moves load forward, and the tire forces add up to m·a', () => {
    const still = solveVehicle(car());
    const r = solveVehicle(car({ brakingG: 1 }));
    expect(r.converged).toBe(true);
    expect(r.pose.pitch).toBeGreaterThan(still.pose.pitch); // + pitch = nose down
    const longTotal = CORNER_IDS.reduce((s, id) => s + r.corners[id].longitudinalForce, 0);
    expect(longTotal).toBeCloseTo(-MASS * G, 3);
    const front = r.corners.FL.longitudinalForce + r.corners.FR.longitudinalForce;
    expect(front / longTotal).toBeCloseTo(0.6, 6); // brake bias
    // Longitudinal load transfer obeys statics: ΔW_front · L ≈ m · a · h.
    const dW = sumLoad(r, ['FL', 'FR']) - sumLoad(still, ['FL', 'FR']);
    expect(Math.abs(dW * WB - MASS * G * 280) / (MASS * G * 280)).toBeLessThan(0.05);
  });

  it('brake mounting changes the dive the way the anti-dive geometry predicts', () => {
    // Incline the front upper arm's pivot axis to create a side-view instant center.
    const anti: DoubleWishboneGeometry = { ...base, uca: setPivotInclination(base.uca, rad(8)) };
    const c = characteristics(new DoubleWishbone(anti).design());
    const out = solveVehicle(car({ front: anti, brakingG: 1, brake: 'outboard' }));
    const inb = solveVehicle(car({ front: anti, brakingG: 1, brake: 'inboard' }));
    const plain = solveVehicle(car({ brakingG: 1 }));
    expect(out.converged && inb.converged && plain.converged).toBe(true);
    // Anti-dive % = tan θ · (L/h) · bias, with θ from the contact patch (outboard) or wheel center (inboard).
    const antiOut = Math.tan(c.antiAngleContact);
    const antiIn = Math.tan(c.antiAngleWheelCenter);
    // More anti-dive → less pitch than the plain car (and vice versa).
    expect(Math.sign(plain.pose.pitch - out.pose.pitch)).toBe(Math.sign(antiOut));
    expect(Math.sign(plain.pose.pitch - inb.pose.pitch)).toBe(Math.sign(antiIn));
    expect(Math.sign(inb.pose.pitch - out.pose.pitch)).toBe(Math.sign(antiOut - antiIn));
  });
});

describe('drive (powered corners)', () => {
  it('rear-wheel drive: rear squats, load moves rearward per statics, open diff splits evenly', () => {
    const still = solveVehicle(car());
    const r = solveVehicle(car({ accelG: 0.5, rearDrive: 'chassis' }));
    expect(r.converged).toBe(true);
    expect(r.notes).toEqual([]);
    expect(r.pose.pitch).toBeLessThan(still.pose.pitch); // nose up
    expect(r.corners.RL.driveForce + r.corners.RR.driveForce).toBeCloseTo(0.5 * MASS * G, 3);
    expect(r.corners.FL.driveForce).toBe(0);
    expect(r.corners.RL.driveForce).toBeCloseTo(r.corners.RR.driveForce, 9);
    const dW = sumLoad(r, ['RL', 'RR']) - sumLoad(still, ['RL', 'RR']);
    expect(Math.abs(dW * WB - 0.5 * MASS * G * 280) / (0.5 * MASS * G * 280)).toBeLessThan(0.05);
  });

  it('acceleration without powered corners is ignored, with a note', () => {
    const r = solveVehicle(car({ accelG: 0.5 }));
    expect(r.notes.length).toBe(1);
    expect(CORNER_IDS.every((id) => r.corners[id].driveForce === 0)).toBe(true);
  });

  it('hub motor vs chassis drive changes squat the way the anti-squat geometry predicts', () => {
    const anti: DoubleWishboneGeometry = { ...base, uca: setPivotInclination(base.uca, rad(-8)) };
    const c = characteristics(new DoubleWishbone(anti).design());
    const chassis = solveVehicle(car({ rear: anti, accelG: 0.6, rearDrive: 'chassis' }));
    const hub = solveVehicle(car({ rear: anti, accelG: 0.6, rearDrive: 'hub' }));
    const plain = solveVehicle(car({ accelG: 0.6, rearDrive: 'chassis' }));
    expect(chassis.converged && hub.converged && plain.converged).toBe(true);
    // Rear anti-squat ∝ −tan θ (θ from the contact patch for a hub motor, the wheel center for a chassis diff).
    const antiHub = -Math.tan(c.antiAngleContact);
    const antiChassis = -Math.tan(c.antiAngleWheelCenter);
    // More anti-squat → less nose-up pitch (pitch is negative when the nose rises).
    expect(Math.sign(hub.pose.pitch - plain.pose.pitch)).toBe(Math.sign(antiHub));
    expect(Math.sign(chassis.pose.pitch - plain.pose.pitch)).toBe(Math.sign(antiChassis));
  });
});

describe('shared components', () => {
  it('a front anti-roll bar reduces roll and shifts load transfer to the front', () => {
    const plain = solveVehicle(car({ lateralG: 1 }));
    const arb = solveVehicle(car({ lateralG: 1, shared: { front: { ...NONE, antiRollBar: { kind: 'wheelRate', rate: 30 } }, rear: NONE } }));
    expect(arb.converged).toBe(true);
    expect(arb.pose.roll).toBeLessThan(plain.pose.roll);
    const transfer = (r: typeof plain, l: 'FL' | 'RL', rr: 'FR' | 'RR') => (r.corners[rr].tireLoad - r.corners[l].tireLoad) / 2;
    const lltd = (r: typeof plain) => transfer(r, 'FL', 'FR') / (transfer(r, 'FL', 'FR') + transfer(r, 'RL', 'RR'));
    expect(lltd(arb)).toBeGreaterThan(lltd(plain) + 0.03);
  });

  it('a torsion bar with drop links matches a wheel-rate bar of the equivalent rate', () => {
    const lever = 120;
    const barRate = 400e3; // N·mm/rad
    const mr = new CornerTable(new DoubleWishbone(base), 0, [-50, 50], 41, DROP_LINK).at(0).dex.y; // link motion per wheel mm
    const equivalent = (barRate * mr * mr) / (lever * lever);
    const tb = solveVehicle(car({ lateralG: 1, track: DROP_LINK, shared: { front: { ...NONE, antiRollBar: { kind: 'torsionBar', barRate, lever } }, rear: NONE } }));
    const wr = solveVehicle(car({ lateralG: 1, shared: { front: { ...NONE, antiRollBar: { kind: 'wheelRate', rate: equivalent } }, rear: NONE } }));
    expect(tb.converged && wr.converged).toBe(true);
    expect(Math.abs(tb.pose.roll - wr.pose.roll) / wr.pose.roll).toBeLessThan(0.03);
  });

  it('stays solvable with a very stiff bar at high lateral g (inside wheel may hit its droop limit)', () => {
    const shared = { front: { ...NONE, antiRollBar: { kind: 'wheelRate' as const, rate: 1000 } }, rear: { ...NONE, antiRollBar: { kind: 'wheelRate' as const, rate: 1000 } } };
    const r = solveVehicle(car({ lateralG: 1.6, shared }));
    expect(r.converged).toBe(true);
    const total = CORNER_IDS.reduce((s2, id) => s2 + r.corners[id].tireLoad, 0);
    expect(total).toBeCloseTo(MASS * G, 0);
    // The bar resists the left/right travel difference, so a near-rigid bar keeps the travels almost equal.
    expect(Math.abs(r.corners.FL.travel - r.corners.FR.travel)).toBeLessThan(3);
    expect(Math.abs(r.corners.RL.travel - r.corners.RR.travel)).toBeLessThan(3);
  });

  it('a heave spring stiffens pitch but not roll, and changes nothing at static', () => {
    const shared = { front: { ...NONE, heaveSpring: { kind: 'wheelRate' as const, rate: 40 } }, rear: NONE };
    const s0 = solveVehicle(car());
    const s1 = solveVehicle(car({ shared }));
    expect(Math.abs(s1.pose.heave - s0.pose.heave)).toBeLessThan(0.05);
    const b0 = solveVehicle(car({ brakingG: 1 }));
    const b1 = solveVehicle(car({ brakingG: 1, shared }));
    expect(b1.pose.pitch).toBeLessThan(b0.pose.pitch);
    const l0 = solveVehicle(car({ lateralG: 1 }));
    const l1 = solveVehicle(car({ lateralG: 1, shared }));
    expect(Math.abs(l1.pose.roll - l0.pose.roll) / l0.pose.roll).toBeLessThan(0.02);
  });
});
