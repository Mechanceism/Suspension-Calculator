import { describe, it, expect } from 'vitest';
import {
  eigenvalues, deadZoneGain, shimmyScan, shimmyKick, wornParams, shimmyMatrix, shimmyParams, shimmyReport,
  vehicleGoalValue, evaluateVehicle, runTest, type ShimmyParams,
} from '../src/core';
import { defaultDesign, type AppState } from '../src/app/store';
import { buildVehicleProblem } from '../src/app/optimizer';
import { serializeProject, importProject, FORMAT_VERSION } from '../src/app/project';
import { PRESET_LAYOUTS } from '../src/examples/sampleLayouts';

const r2 = 1 / 0.065 ** 2; // knuckle rad per steering-wheel rad ≈ 1 / 15.4
const car: ShimmyParams = {
  trail: 0.02, pneumaticTrail: 0.03, relaxation: 0.4, cornering: 120000, knuckleInertia: 0.8, wheelInertia: 0.04 * r2,
  stiffness: 30000, freePlay: 0, damper: 20, spinInertia: 1.0, radius: 0.32, hands: { stiffness: 20 * r2, damping: 2 * r2 },
};
const soft: ShimmyParams = { ...car, stiffness: 3000 };
const axle = (damper: number): ShimmyParams => ({ ...car, stiffness: 6000, damper, spinInertia: 3, radius: 0.45, axle: { inertia: 30, stiffness: 2 * 250000 * 0.75 ** 2, damping: 2 * 1000 * 0.75 ** 2, height: 0.35 } });

describe('shimmy model', () => {
  it('eigenvalues of small matrices', () => {
    const e = eigenvalues([[0, 1], [-4, -0.4]]);
    expect(Math.max(...e.map((x) => Math.abs(x.im)))).toBeCloseTo(Math.sqrt(4 - 0.04), 9);
    expect(e.every((x) => Math.abs(x.re + 0.2) < 1e-9)).toBe(true);
    const d = eigenvalues([[-1, 0, 0], [0, -2, 0], [0, 0, 3]]).map((x) => x.re).sort((a, b) => a - b);
    d.forEach((v, i) => expect(v).toBeCloseTo([-2, -1, 3][i]!, 8));
    // The model's matrix: a 5-state system, 7 with a solid axle.
    expect(shimmyMatrix(car, 20)).toHaveLength(5);
    expect(shimmyMatrix(axle(20), 20)).toHaveLength(7);
  });

  it('free play as a spring: nothing inside the play, the whole spring far beyond it', () => {
    expect(deadZoneGain(0.01, 0.005)).toBe(0);
    expect(deadZoneGain(0.01, 0.02)).toBeCloseTo(0.391, 3);
    expect(deadZoneGain(0.01, 10)).toBeGreaterThan(0.99);
    expect(deadZoneGain(0, 0.1)).toBe(1);
  });

  it('a stiff steering is stable; worn parts and a soft steering shimmy; the scan and the kick agree on the onset', () => {
    const s = shimmyScan(car, 45);
    expect(s.onset).toBeNull();
    const worn = shimmyScan(wornParams(car, { freePlay: 0.0175, stiffness: 0.7, damper: 0.5 }), 45);
    expect(worn.minZeta).toBeLessThan(s.minZeta);
    const sf = shimmyScan(soft, 45);
    expect(sf.onset).not.toBeNull();
    expect(sf.points.find((q) => q.speed === sf.worstSpeed)!.frequency).toBeGreaterThan(4);
    // The time simulation (no free play) wobbles just above the onset and settles just below it.
    expect(shimmyKick(soft, sf.onset! + 2).shimmies).toBe(true);
    expect(shimmyKick(soft, Math.max(3, sf.onset! - 3)).shimmies).toBe(false);
    expect(shimmyKick(car, 40).shimmies).toBe(false);
  });

  it('death wobble on a soft solid axle without a steering damper; a steering damper cures it', () => {
    const bad = shimmyScan(axle(0), 45);
    expect(bad.onset).not.toBeNull();
    const f = bad.points.find((q) => q.zeta < 0)!.frequency;
    expect(f).toBeGreaterThan(4);
    expect(f).toBeLessThan(15);
    expect(shimmyKick(axle(0), bad.onset! + 3).shimmies).toBe(true);
    const damped = shimmyScan(axle(300), 45);
    expect(damped.onset).toBeNull();
    expect(damped.minZeta).toBeGreaterThan(bad.minZeta);
  });
});

describe('shimmy on a design', () => {
  const problem = () => buildVehicleProblem(defaultDesign() as unknown as AppState).problem;

  it('parameters from the design; the goal is the worn margin; a solid steered axle includes its tramp', () => {
    const p = problem();
    const sp = shimmyParams(p)!;
    expect(sp).toBeTruthy();
    expect(sp.axle).toBeUndefined();
    expect(sp.pneumaticTrail).toBeGreaterThan(0); // estimated from the patch when the input is 0
    expect(sp.cornering).toBeGreaterThan(1000);
    const rep = shimmyReport(p, undefined, 15)!;
    const geoms = Object.fromEntries(Object.entries(p.designs).map(([r, d]) => [r, d!.geometry]));
    const e = evaluateVehicle({ ...p, cases: { lateralG: 0, brakingG: 0, accelG: 0 }, states: undefined }, geoms)!;
    expect(vehicleGoalValue('shimmy', p, e)).toBeCloseTo(rep.worn.minZeta, 9);
    // A steered solid axle.
    const beam = PRESET_LAYOUTS.find((l) => l.id === 'AS')!.geometry;
    const pb = { ...p, designs: { ...p.designs, FL: { ...p.designs.FL!, geometry: beam } } };
    const sb = shimmyParams(pb);
    expect(sb!.axle).toBeTruthy();
  });

  it('the tests fail Shimmy when the wheels keep wobbling after a kick; not on the default car', () => {
    const p = problem();
    const geoms = Object.fromEntries(Object.entries(p.designs).map(([r, d]) => [r, d!.geometry]));
    const seg = { distance: 200, v0: 30, v1: 30, path: 'straight' as const, radius: 0, grade: 0, bank: 0 };
    const ok = runTest(p, geoms, [seg], { onFail: 'report', speedLimits: false });
    const wob = runTest({ ...p, shimmy: { ...p.shimmy!, stiffness: 1500, damper: 0 } }, geoms, [seg], { onFail: 'report', speedLimits: false });
    expect(wob.shimmy).toBeTruthy();
    expect(wob.segments[0]!.findings.some((f) => f.check === 'shimmy')).toBe(true);
    expect(ok.segments[0]!.findings.some((f) => f.check === 'shimmy')).toBe(!!ok.shimmy);
  });

  it('saves; format 40 files get the default shimmy inputs', () => {
    const d = defaultDesign();
    d.shimmy = { ...d.shimmy, check: false, handsOn: false, shimDamper: { text: '150', value: 150 } };
    const back = importProject(JSON.parse(JSON.stringify(serializeProject(d, 'S'))));
    expect(back.warnings).toEqual([]);
    expect(back.design.shimmy.check).toBe(false);
    expect(back.design.shimmy.handsOn).toBe(false);
    expect(back.design.shimmy.shimDamper.value).toBe(150);
    const old = JSON.parse(JSON.stringify(serializeProject(defaultDesign(), 'O')));
    old.formatVersion = 40;
    delete old.shimmy;
    const r = importProject(old);
    expect(r.warnings).toEqual(Array.from({ length: FORMAT_VERSION - 40 }, (_, i) => `Upgraded from file format ${i + 40} to ${i + 41}.`));
    expect(r.design.shimmy.check).toBe(true);
  });
});
