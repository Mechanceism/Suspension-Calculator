import { describe, it, expect } from 'vitest';
import { defaultDesign, defaultOptimizerSetup, type AppState, type DesignState } from '../src/app/store';
import { buildProblem, buildVehicleProblem, varKey } from '../src/app/optimizer';
import { serializeProject, importProject } from '../src/app/project';

const f = (v: number) => ({ text: String(v), value: v });

function withSetup(d: DesignState): DesignState {
  const o = defaultOptimizerSetup();
  o.ranges[varKey('trInner', 1)] = { lo: f(80), hi: f(120) };
  o.ranges[varKey('trOuter', 1)] = { lo: f(80), hi: f(120) };
  o.ranges[varKey('ucaFwd', 0)] = { lo: f(100), hi: f(200) };
  o.goals.bumpSteer = { ...o.goals.bumpSteer, on: true };
  o.rackCheck = f(20);
  d.optimizer = { FL: o };
  return d;
}

describe('optimizer setup (app)', () => {
  it('builds a problem from the active design; locked coordinates are skipped and locked arm dimensions held', () => {
    const d = withSetup(defaultDesign());
    d.locks = { 'FL.point.trOuter.y': true, 'FL.derived.uca.length': true };
    const b = buildProblem(d as AppState);
    expect(b.blockers).toEqual([]);
    expect(b.skippedLocked).toEqual(['trOuter.y']);
    expect(b.problem.variables.map((v) => `${v.point}.${v.axis}`).sort()).toEqual(['trInner.1', 'ucaFwd.0']);
    expect(b.problem.holds).toEqual([{ arm: 'uca', which: 'length' }]);
    expect(b.problem.goals.map((g) => g.kind)).toEqual(['bumpSteer']);
    expect(b.problem.rackPositions).toEqual([-20, 20]); // FL steers by default
    expect(b.problem.droop).toBeLessThan(0);
  });

  it('a part lock removes all of its coordinates; nothing left blocks the run', () => {
    const d = withSetup(defaultDesign());
    d.locks = { 'FL.part.tieRod': true, 'FL.part.uca': true };
    const b = buildProblem(d as AppState);
    expect(b.problem.variables).toEqual([]);
    expect(b.blockers.join(' ')).toMatch(/locked/);
  });

  it('saves and loads both optimizer setups and the grip model with the project (format 6)', () => {
    const d = withSetup(defaultDesign());
    d.vehicleOptimizer.ranges['FL.ucaFwd.y'] = { lo: f(250), hi: f(300) };
    d.vehicleOptimizer.goals.grip = { ...d.vehicleOptimizer.goals.grip, on: true };
    d.vehicleOptimizer.lateralG = f(1.2);
    d.grip.sensitivity = f(0.25);
    const file = JSON.parse(JSON.stringify(serializeProject(d, 'Opt')));
    expect(file.formatVersion).toBe(11);
    const r = importProject(file);
    expect(r.warnings).toEqual([]);
    expect(r.design.optimizer).toEqual(d.optimizer);
    expect(r.design.vehicleOptimizer).toEqual(d.vehicleOptimizer);
    expect(r.design.grip).toEqual(d.grip);
  });

  it('opens a format-4 file with no optimizer setups (defaults)', () => {
    const file = JSON.parse(JSON.stringify(serializeProject(defaultDesign(), 'Old')));
    file.formatVersion = 4;
    delete file.optimizer;
    delete file.vehicleOptimizer;
    delete file.grip;
    const r = importProject(file);
    expect(r.warnings).toEqual(['Upgraded from file format 4 to 5.', 'Upgraded from file format 5 to 6.', 'Upgraded from file format 6 to 7.', 'Upgraded from file format 7 to 8.', 'Upgraded from file format 8 to 9.', 'Upgraded from file format 9 to 10.', 'Upgraded from file format 10 to 11.']);
    expect(r.design.optimizer).toEqual({});
    expect(r.design.vehicleOptimizer).toEqual(defaultDesign().vehicleOptimizer);
    expect(r.design.grip).toEqual(defaultDesign().grip);
  });

  it('builds a vehicle problem: one design per root, locked coordinates skipped, cases and grip passed', () => {
    const d = defaultDesign();
    d.links = { frontPair: true, rearPair: true, rearFromFront: false }; // front and rear designs
    d.corners.RL = d.corners.FL;
    d.vehicleOptimizer.ranges['FL.ucaFwd.y'] = { lo: f(250), hi: f(300) };
    d.vehicleOptimizer.ranges['RL.ucaFwd.y'] = { lo: f(250), hi: f(300) };
    d.vehicleOptimizer.ranges['RL.trInner.y'] = { lo: f(80), hi: f(120) };
    d.vehicleOptimizer.goals.lltd = { ...d.vehicleOptimizer.goals.lltd, on: true };
    d.locks = { 'RL.part.tieRod': true };
    const b = buildVehicleProblem(d as AppState);
    expect(Object.keys(b.problem.designs).sort()).toEqual(['FL', 'RL']);
    expect(b.problem.roots).toEqual({ FL: 'FL', FR: 'FL', RL: 'RL', RR: 'RL' });
    expect(b.problem.variables.map((v) => `${v.root}.${v.point}.${v.axis}`).sort()).toEqual(['FL.ucaFwd.1', 'RL.ucaFwd.1']);
    expect(b.skippedLocked).toEqual(['RL.trInner.y']);
    expect(b.problem.cases).toEqual({ lateralG: 1, brakingG: 1, accelG: 0 });
    expect(b.problem.grip?.muRef).toBe(1);
    expect(b.blockers).toEqual([]);
  });
});
