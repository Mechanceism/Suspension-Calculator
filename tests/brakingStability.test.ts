import { describe, it, expect } from 'vitest';
import { carProfileDesign } from '../src/app/carProfiles';
import { buildVehicleProblem } from '../src/app/optimizer';
import {
  assembleVehicle, vehicleInputOf, solveVehicle, liftedUnexpectedly, DoubleWishbone, lowerArmAngle, type ChassisPose,
} from '../src/core';
import { PRESET_LAYOUTS } from '../src/examples/sampleLayouts';

const G = 9.80665;
const carOf = (id: string) => {
  const d = carProfileDesign(id);
  const { problem } = buildVehicleProblem(d as never);
  const asm = assembleVehicle(problem, Object.fromEntries(Object.entries(problem.designs).map(([r, x]) => [r, x!.geometry])))!;
  return { problem, asm };
};

describe('hard braking stays on the physical balance', () => {
  it('trophy truck: every braking level converges with the rear tires loaded about as rigid statics says', () => {
    const { problem, asm } = carOf('trophy');
    const h = problem.cg.height, L = problem.wheelbase, W = problem.mass * G;
    for (const b of [0.3, 0.6, 0.9, 1.2]) {
      const r = solveVehicle(vehicleInputOf(problem, asm, { lateralG: 0, brakingG: b, accelG: 0 }));
      expect(r.converged).toBe(true);
      expect(r.pose.pitch).toBeGreaterThan(0); // nose down
      expect(r.pose.pitch).toBeLessThan((10 * Math.PI) / 180);
      const rear = r.corners.RL.tireLoad + r.corners.RR.tireLoad;
      const rigid = W * 0.5 - b * W * h / L;
      expect(rear).toBeGreaterThan(0);
      expect(Math.abs(rear - rigid) / W).toBeLessThan(0.05);
    }
  });

  it('road car at 1.2 g keeps its rear wheels on the ground (no "stoppie" balance)', () => {
    const { problem, asm } = carOf('road');
    const r = solveVehicle(vehicleInputOf(problem, asm, { lateralG: 0, brakingG: 1.2, accelG: 0 }));
    expect(r.converged).toBe(true);
    expect(r.corners.RL.tireLoad).toBeGreaterThan(300);
    expect(r.pose.pitch).toBeLessThan((5 * Math.PI) / 180);
  });

  it('playback: warm-started steps through braking and accelerating all converge', () => {
    const { problem, asm } = carOf('trophy');
    let guess: ChassisPose | undefined;
    for (let i = 0; i <= 24; i++) {
      const s = Math.sin((i / 24) * 2 * Math.PI);
      const lg = s < 0 ? 1.2 * s : 0.6 * s;
      const r = solveVehicle(vehicleInputOf(problem, asm, { lateralG: 0, brakingG: lg < 0 ? -lg : 0, accelG: lg > 0 ? lg : 0 }), { guess });
      expect(r.converged).toBe(true);
      expect(liftedUnexpectedly(vehicleInputOf(problem, asm, { lateralG: 0, brakingG: lg < 0 ? -lg : 0, accelG: lg > 0 ? lg : 0 }), r)).toBe(false);
      guess = r.pose;
    }
  }, 60_000);

  it('flags an axle off the ground that a rigid car would keep loaded', () => {
    const { problem, asm } = carOf('road');
    const inp = vehicleInputOf(problem, asm, { lateralG: 0, brakingG: 0.5, accelG: 0 });
    const r = solveVehicle(inp);
    expect(liftedUnexpectedly(inp, r)).toBe(false);
    const fake = { ...r, corners: { ...r.corners, RL: { ...r.corners.RL, tireLoad: 0 }, RR: { ...r.corners.RR, tireLoad: 0 } } };
    expect(liftedUnexpectedly(inp, fake)).toBe(true);
  });
});

describe('travel tables at their ends', () => {
  it('keep the full slope at full droop and full bump (motion ratio and wheel path)', () => {
    const { asm } = carOf('trophy');
    const fl = asm.corners.find((c) => c.id === 'FL')!;
    const rl = asm.corners.find((c) => c.id === 'RL')!;
    for (const t of [fl.table, rl.table]) {
      const near = (q: number) => t.at(q);
      const step = (t.hi - t.lo) / 20;
      for (const [end, inside] of [[t.lo, t.lo + step], [t.hi, t.hi - step]] as const) {
        expect(near(end).dwc.y).toBeCloseTo(near(inside).dwc.y, 1);
        expect(near(end).dL / near(inside).dL).toBeGreaterThan(0.9);
      }
    }
  });
});

describe('every suspension preset', () => {
  it('solves, and the lower-arm angle is defined (0 for single-pivot links) without throwing', () => {
    for (const l of PRESET_LAYOUTS) {
      const corner = new DoubleWishbone(l.geometry);
      const st = corner.solve({ travel: 20, rack: 0 });
      expect(st.solve.status, l.id).toBe('converged');
      expect(() => lowerArmAngle(l.geometry, st), l.id).not.toThrow();
      expect(Number.isFinite(lowerArmAngle(l.geometry, st)), l.id).toBe(true);
    }
  });
});
