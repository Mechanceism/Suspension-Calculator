import { describe, it, expect } from 'vitest';
import { CAR_PROFILES, carProfileDesign, scaleGeometry } from '../src/app/carProfiles';
import { toGeometry, vehicleStaticLoads } from '../src/app/store';
import { buildVehicleProblem } from '../src/app/optimizer';
import { serializeProject, importProject } from '../src/app/project';
import { DoubleWishbone, evaluateVehicle } from '../src/core';
import { SAMPLE_LAYOUTS } from '../src/examples/sampleLayouts';

const G = 9.80665;

describe('car profiles', () => {
  it('scales a layout to a tire size and track, keeping the spin axis', () => {
    const g = SAMPLE_LAYOUTS[2]!.geometry;
    const s = scaleGeometry(g, 1.5, 2);
    expect(s.wheel.center.x).toBeCloseTo(g.wheel.center.x * 1.5, 9);
    expect(s.wheel.center.y).toBeCloseTo(g.wheel.center.y * 2, 9);
    expect(s.uca.fwd.z).toBeCloseTo(g.uca.fwd.z * 2, 9);
    expect(s.wheel.radius).toBeCloseTo(g.wheel.radius * 2, 9);
    expect(s.wheel.spinAxis).toEqual(g.wheel.spinAxis);
  });

  for (const p of CAR_PROFILES) {
    it(`${p.label}: every corner solves over its travel and the whole car settles`, () => {
      const d = carProfileDesign(p.id);
      expect(d.vehicle.mass.value).toBe(p.mass);
      expect(d.links.rearFromFront).toBe(false);
      // Corners hold only corner fields (applyDesign spreads the active corner over the design).
      for (const k of ['vehicle', 'links', 'corners', 'settings']) expect(k in d.corners.FL).toBe(false);
      for (const id of ['FL', 'RL'] as const) {
        const c = d.corners[id];
        const a = id === 'FL' ? p.front : p.rear;
        const g = toGeometry(c.geom);
        // Tire size and track as asked.
        expect(g.wheel.radius).toBeCloseTo(a.tire.diameter / 2, 6);
        expect(Math.abs(g.wheel.center.x)).toBeCloseTo(a.halfTrack, 0);
        for (const travel of [-p.droop, 0, p.bump]) {
          expect(new DoubleWishbone(g).solve({ travel, rack: 0 }).solve.status).toBe('converged');
        }
        expect(c.spring.springRate.value).toBeGreaterThan(0);
        expect(c.damper.maxLength.value).toBeGreaterThan(c.damper.minLength.value);
        expect(c.damper.bumpDamping.value).toBeGreaterThan(0);
      }
      // Static loads carry the whole car, split by the CG.
      const loads = vehicleStaticLoads(d.vehicle, d.corners, d.links);
      const total = loads.FL + loads.FR + loads.RL + loads.RR;
      expect(total).toBeCloseTo(p.mass * G, 0);
      expect((loads.FL + loads.FR) / total).toBeCloseTo(p.frontShare, 2);
      // The grip model is centred on this car's tires: about μ 1 at the static load.
      expect(d.tireGrip.fz0.value).toBeCloseTo(total / 4, -2);
      // Drive and brakes.
      expect(d.settings.FL.powered).toBe(p.drive !== 'rear');
      expect(d.settings.RL.powered).toBe(p.drive !== 'front');
      expect(d.settings.FL.brake).toBe(p.brakes === 'rear' ? 'none' : 'outboard');

      // The whole car solves in a gentle turn, with the body near its design ride height.
      const { problem } = buildVehicleProblem({ ...d, vehicleOptimizer: { ...d.vehicleOptimizer, lateralG: { text: '0.3', value: 0.3 }, brakingG: { text: '0', value: 0 } } } as never);
      const geoms = Object.fromEntries(Object.entries(problem.designs).map(([r, x]) => [r, x!.geometry]));
      const e = evaluateVehicle(problem, geoms);
      expect(e).not.toBeNull();
      expect(Math.abs(e!.cases[0]!.result.pose.roll)).toBeLessThan(0.1); // rad
    });
  }

  it('round-trips through a project file', () => {
    const d = carProfileDesign('trophy');
    const r = importProject(JSON.parse(JSON.stringify(serializeProject(d, 'Truck'))));
    expect(r.warnings).toEqual([]);
    expect(r.design.corners.RL.geom.kind).toBe('beam4');
    expect(r.design.corners.FL.geom.scalars.tireDiameter.value).toBe(1016);
    expect(r.design.vehicle.mass.value).toBe(2700);
  });
});
