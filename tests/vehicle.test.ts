import { describe, it, expect } from 'vitest';
import {
  DoubleWishbone, CornerTable, solveVehicle, staticCornerLoads, fitFreeLength, CORNER_IDS, designGroundY,
  vec3, deg, characteristics, axleRollCenter, placement,
  type VehicleInput, type TireForceModel,
} from '../src/core';
import { SAMPLE_LAYOUTS, SAMPLE_SPRING } from '../src/examples/sampleLayouts';

const G = 9.80665;
const geom = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
const corner = new DoubleWishbone(geom);
const profile = { radius: 260, width: 205, shoulderRadius: 25, rimRadius: 165 };
const gas: TireForceModel = {
  kind: 'gas', volumeChange: true, volumeFactor: 1,
  conditions: { setPressure: 83, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 },
};
const WHEELBASE = 1550;
const MASS = 300;
const UNSPRUNG = 12;
const contactX = corner.design().points.contact.x;

/** Build a vehicle with the same corner everywhere and springs fitted to hold the static loads at design height. */
function vehicle(cg = vec3(0, 280, -0.47 * WHEELBASE), lateralG = 0): VehicleInput {
  const loads = staticCornerLoads(MASS, cg, WHEELBASE, { FL: contactX, FR: contactX, RL: contactX, RR: contactX });
  const table = new CornerTable(corner, 0, [-50, 50]);
  const contactY = corner.design().points.contact.y;
  const groundY = designGroundY(CORNER_IDS.map((id) => ({ contactY, profile, model: gas, staticLoad: loads[id], tilt: 0 })));
  return {
    totalMass: MASS, cg, wheelbase: WHEELBASE, groundY, lateralG,
    corners: CORNER_IDS.map((id) => ({
      id, table, unsprungMass: UNSPRUNG, tire: { profile, model: gas },
      spring: { rate: SAMPLE_SPRING.rate, freeLength: fitFreeLength(corner, SAMPLE_SPRING.rate, loads[id] - UNSPRUNG * G) },
    })),
  };
}

describe('corner table', () => {
  it('interpolates the exact solve closely, including slope', () => {
    const t = new CornerTable(corner, 0, [-50, 50]);
    for (const q of [-33.3, -7.1, 0, 12.6, 41.9]) {
      const exact = corner.solve({ travel: q });
      const a = t.at(q);
      expect(Math.abs(a.wc.y - exact.points.wheelCenter.y)).toBeLessThan(1e-3);
      expect(Math.abs(a.cp.x - exact.points.contact.x)).toBeLessThan(1e-2);
      expect(a.dwc.y).toBeCloseTo(1, 3); // wheel-center travel driver: dY/dq = 1
    }
  });
});

describe('vehicle equilibrium', () => {
  it('static, springs fitted to the CG loads: sits at the design height with no roll or pitch', () => {
    const r = solveVehicle(vehicle());
    expect(r.converged).toBe(true);
    expect(Math.abs(r.pose.heave)).toBeLessThan(0.3);
    expect(Math.abs(deg(r.pose.roll))).toBeLessThan(1e-3);
    expect(Math.abs(deg(r.pose.pitch))).toBeLessThan(0.02);
    for (const id of CORNER_IDS) expect(Math.abs(r.corners[id].travel)).toBeLessThan(0.5);
    const total = CORNER_IDS.reduce((s, id) => s + r.corners[id].tireLoad, 0);
    expect(total).toBeCloseTo(MASS * G, 1);
    // Front/rear split follows the CG position (47% of the wheelbase behind the front axle → 53% front).
    const front = r.corners.FL.tireLoad + r.corners.FR.tireLoad;
    expect(front / total).toBeCloseTo(0.53, 2);
  });

  it('cornering left (+X): body rolls to the outside, outside tires gain load, forces balance', () => {
    const r = solveVehicle(vehicle(undefined, 1.0));
    expect(r.converged).toBe(true);
    expect(r.corners.FR.tireLoad).toBeGreaterThan(r.corners.FL.tireLoad); // right side is outside
    expect(r.corners.RR.tireLoad).toBeGreaterThan(r.corners.RL.tireLoad);
    expect(r.pose.roll).toBeGreaterThan(0); // + roll about +Z leans the top toward −X (outside)
    const lat = CORNER_IDS.reduce((s, id) => s + r.corners[id].lateralForce, 0);
    expect(lat).toBeCloseTo(MASS * G, 3);
    // Total lateral load transfer obeys statics: ΣΔW·track = m·a·h (h, track at the deflected state).
    const dWf = (r.corners.FR.tireLoad - r.corners.FL.tireLoad) / 2;
    const dWr = (r.corners.RR.tireLoad - r.corners.RL.tireLoad) / 2;
    const tf = r.corners.FL.contact.x - r.corners.FR.contact.x;
    const tr = r.corners.RL.contact.x - r.corners.RR.contact.x;
    const lhs = dWf * tf + dWr * tr;
    const rhs = MASS * G * 1.0 * (280 - r.corners.FL.contact.y);
    expect(Math.abs(lhs - rhs) / rhs).toBeLessThan(0.05);
  });

  it('CG offset to the left loads the left tires', () => {
    const r = solveVehicle(vehicle(vec3(30, 280, -0.47 * WHEELBASE)));
    expect(r.converged).toBe(true);
    expect(r.corners.FL.tireLoad).toBeGreaterThan(r.corners.FR.tireLoad);
  });
});

describe('axle roll center', () => {
  it('matches the single-corner mirrored roll center for a symmetric axle', () => {
    const c = characteristics(corner.design());
    const pl = placement('FL', WHEELBASE);
    const pr = placement('FR', WHEELBASE);
    const rc = axleRollCenter(
      { contact: pl.point(c.contactPoint), ic: c.frontViewIC ? pl.point(c.frontViewIC) : null },
      { contact: pr.point(c.contactPoint), ic: c.frontViewIC ? pr.point(c.frontViewIC) : null },
    )!;
    expect(rc.x).toBeCloseTo(0, 6);
    expect(rc.y - c.groundY).toBeCloseTo(c.rollCenterHeight!, 6);
  });
});

