import { describe, it, expect, beforeEach } from 'vitest';
import { useApp, defaultDesign, defaultOptimizerSetup, type AppState } from '../src/app/store';
import { serializeProject, importProject, FORMAT_VERSION } from '../src/app/project';
import { axleRoots, wizardKeys, lockKeys } from '../src/app/locks';
import { buildProblem } from '../src/app/optimizer';
import { rateVars } from '../src/app/testOptimize';

const f = (v: number) => ({ text: String(v), value: v });

describe('setup wizard: entered values are locked', () => {
  beforeEach(() => { useApp.setState({ ...defaultDesign() }); });

  it('lock keys per step follow the shared designs', () => {
    const linked = { frontPair: true, rearPair: true, rearFromFront: true };
    expect(axleRoots(linked, 'front')).toEqual(['FL']);
    expect(axleRoots(linked, 'rear')).toEqual(['FL']);
    expect(axleRoots({ frontPair: true, rearPair: true, rearFromFront: false }, 'rear')).toEqual(['RL']);
    expect(axleRoots({ frontPair: false, rearPair: true, rearFromFront: false }, 'front')).toEqual(['FL', 'FR']);
    // Track and wheelbase are held as the wheel centers' X and Z.
    expect(wizardKeys.size(['FL'])).toEqual(['vehicle.wheelbase', 'FL.point.wheelCenter.x', 'FL.point.wheelCenter.z']);
    expect(wizardKeys.dampers(['FL', 'RL'], ['rear'])).toEqual([
      'FL.damper.bumpDamping', 'FL.damper.reboundDamping', 'RL.damper.bumpDamping', 'RL.damper.reboundDamping', 'shared.rear.arbRate',
    ]);
    expect(wizardKeys.tires(['FL'])).toContain('FL.tire.pressure');
  });

  it('applying a step locks its values; re-applying replaces them; an estimate frees them; the user\'s own locks stay', () => {
    const st = () => useApp.getState();
    st().setLocks(['FL.spring.springRate'], true); // locked by hand before the wizard
    st().setSetupStatus('springs', 'entered');
    st().lockFromWizard('springs', ['FL.spring.springRate', 'RL.spring.springRate']);
    expect(st().locks['RL.spring.springRate']).toBe(true);
    expect(st().wizardLocks).toEqual({ 'RL.spring.springRate': 'springs' });
    st().lockFromWizard('dampers', wizardKeys.dampers(['FL'], ['front']));
    expect(st().wizardLocks['shared.front.arbRate']).toBe('dampers');
    // Re-applied without the bar: its lock goes.
    st().lockFromWizard('dampers', wizardKeys.dampers(['FL'], []));
    expect(st().locks['shared.front.arbRate']).toBeUndefined();
    expect(st().locks['FL.damper.bumpDamping']).toBe(true);
    // "Use an estimate" on a step frees only what that step locked.
    st().setSetupStatus('springs', 'estimated');
    expect(st().locks['RL.spring.springRate']).toBeUndefined();
    expect(st().locks['FL.spring.springRate']).toBe(true);
    expect(st().locks['FL.damper.bumpDamping']).toBe(true);
    // Unlocking by hand drops the tag; unlock all clears both.
    st().toggleLock('FL.damper.bumpDamping');
    expect(st().wizardLocks['FL.damper.bumpDamping']).toBeUndefined();
    st().clearLocks();
    expect(st().locks).toEqual({});
    expect(st().wizardLocks).toEqual({});
  });

  it('the optimizers keep locked setup values: static camber, tire pressure, anti-roll bars', () => {
    const d = defaultDesign();
    const o = defaultOptimizerSetup();
    o.ranges['scalar.staticCamber'] = { lo: f(-3), hi: f(0) };
    o.ranges['scalar.tirePressure'] = { lo: f(60), hi: f(120) };
    const state = (locks: Record<string, true>) => ({ ...d, tireModel: 'gas', optimizer: { FL: o }, locks } as AppState);
    const free = buildProblem(state({}));
    expect(free.problem.variables.map((v) => v.point)).toEqual(['staticCamber', 'tirePressure']);
    const locked = buildProblem(state({ [lockKeys.field('FL', 'scalar', 'staticCamber')]: true, 'FL.tire.pressure': true }));
    expect(locked.problem.variables).toEqual([]);
    expect(locked.skippedLocked.sort()).toEqual(['scalar.staticCamber', 'scalar.tirePressure']);

    useApp.setState({ ...d, shared: { ...d.shared, front: { ...d.shared.front, antiRollBar: 'wheelRate', arbRate: f(10) } } });
    const settings = { springs: false, dampers: false, bars: true, spread: 2, budget: 10, withLoop: true };
    expect(rateVars(useApp.getState(), settings).map((v) => v.axle)).toEqual(['front']);
    useApp.getState().lockFromWizard('dampers', ['shared.front.arbRate']);
    expect(rateVars(useApp.getState(), settings)).toEqual([]);
  });

  it('wizard locks save with the project; format 36 files load with none', () => {
    const d = defaultDesign();
    d.locks = { 'vehicle.mass': true, 'FL.spring.springRate': true };
    d.wizardLocks = { 'vehicle.mass': 'weight', 'vehicle.cgX': 'weight' }; // cgX isn't locked: dropped
    const back = importProject(JSON.parse(JSON.stringify(serializeProject(d, 'W'))));
    expect(back.warnings).toEqual([]);
    expect(back.design.wizardLocks).toEqual({ 'vehicle.mass': 'weight' });
    expect(back.design.locks['FL.spring.springRate']).toBe(true);
    const old = JSON.parse(JSON.stringify(serializeProject(d, 'Old')));
    old.formatVersion = 36;
    delete old.wizardLocks;
    const r = importProject(old);
    expect(FORMAT_VERSION).toBeGreaterThanOrEqual(37);
    expect(r.warnings).toEqual(Array.from({ length: FORMAT_VERSION - 36 }, (_, i) => `Upgraded from file format ${i + 36} to ${i + 37}.`));
    expect(r.design.wizardLocks).toEqual({});
    expect(r.design.locks['vehicle.mass']).toBe(true);
  });
});
