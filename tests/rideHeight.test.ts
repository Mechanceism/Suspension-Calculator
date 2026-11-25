import { describe, expect, it } from 'vitest';
import { staticTravelFor, assembleVehicle, solveCase } from '../src/core/optimize/vehicle';
import { defaultDesign, type AppState } from '../src/app/store';
import { buildVehicleProblem } from '../src/app/optimizer';
import { serializeProject, importProject } from '../src/app/project';

// Round 4 (F21): a set static ride height — the springs' preload fitted so the chassis rests there.
describe('static ride height', () => {
  it('the travel at rest: design − target, kept inside the travel', () => {
    expect(staticTravelFor(-100, undefined, 50, 50)).toEqual({ travel: 0, clamped: false, design: 100 });
    expect(staticTravelFor(-100, 85, 50, 50).travel).toBeCloseTo(15, 9); // 15 mm lower: 15 mm into bump
    expect(staticTravelFor(-100, 120, 50, 50).travel).toBeCloseTo(-20, 9); // higher: into droop
    expect(staticTravelFor(-100, 20, 50, 50)).toMatchObject({ travel: 48, clamped: true });
  });

  it('the car rests at the set height: the front 15 mm lower, the rear 10 mm higher', () => {
    const d = defaultDesign();
    const base = buildVehicleProblem(d as unknown as AppState).problem;
    const geoms = Object.fromEntries(Object.entries(base.designs).map(([r, x]) => [r, x!.geometry]));
    const design = -assembleVehicle(base, geoms)!.groundY;
    const p = buildVehicleProblem({ ...d, rideHeight: { on: true, front: { text: '', value: design - 15 }, rear: { text: '', value: design + 10 } } } as unknown as AppState).problem;
    expect(p.rideHeight).toEqual({ front: design - 15, rear: design + 10 });
    const rest = solveCase(p, assembleVehicle(p, geoms)!, { name: 'rest', kind: 'lateral', g: 0, lateralG: 0, brakingG: 0, accelG: 0 })!;
    expect(rest.result.corners.FL.travel).toBeCloseTo(15, 0);
    expect(rest.result.corners.RL.travel).toBeCloseTo(-10, 0);
    // Not set: at the design position.
    const plain = solveCase(base, assembleVehicle(base, geoms)!, { name: 'rest', kind: 'lateral', g: 0, lateralG: 0, brakingG: 0, accelG: 0 })!;
    expect(Math.abs(plain.result.corners.FL.travel)).toBeLessThan(0.5);
  }, 60000);

  it('saved with the project (format 48); older files rest at the design position', () => {
    const d = { ...defaultDesign(), rideHeight: { on: true, front: { text: '90', value: 90 }, rear: { text: '95', value: 95 } } };
    const file = JSON.parse(JSON.stringify(serializeProject(d, 'R')));
    expect(importProject(file).design.rideHeight).toEqual(d.rideHeight);
    delete file.rideHeight;
    expect(importProject(file).design.rideHeight.on).toBe(false);
  });
});
