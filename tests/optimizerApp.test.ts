import { describe, it, expect } from 'vitest';
import { defaultDesign, defaultOptimizerSetup, type AppState, type DesignState } from '../src/app/store';
import { buildProblem, varKey } from '../src/app/optimizer';
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

  it('saves and loads the optimizer setup with the project (format 5)', () => {
    const d = withSetup(defaultDesign());
    const file = JSON.parse(JSON.stringify(serializeProject(d, 'Opt')));
    expect(file.formatVersion).toBe(5);
    const r = importProject(file);
    expect(r.warnings).toEqual([]);
    expect(r.design.optimizer).toEqual(d.optimizer);
  });

  it('opens a format-4 file with no optimizer setup', () => {
    const file = JSON.parse(JSON.stringify(serializeProject(defaultDesign(), 'Old')));
    file.formatVersion = 4;
    delete file.optimizer;
    const r = importProject(file);
    expect(r.warnings).toEqual(['Upgraded from file format 4 to 5.']);
    expect(r.design.optimizer).toEqual({});
  });
});
