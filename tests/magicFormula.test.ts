import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MF, mfLateral, mfLongitudinal, mfPeaks, mfPeakSlips, mfSlipAngle, mfSlipRatio,
  assembleVehicle, solveCase, runTest, type VehicleProblem, type TireForceModel, type SegmentSpec,
} from '../src/core';
import { SAMPLE_LAYOUTS, SAMPLE_SPRING } from '../src/examples/sampleLayouts';
import { defaultDesign } from '../src/app/store';
import { serializeProject, importProject } from '../src/app/project';

const m = DEFAULT_MF;
const DEG = Math.PI / 180;

describe('Magic Formula tire', () => {
  it('peaks at D = pDy1·Fz at the nominal load, is odd in slip angle when level, and slides at sin(C·π/2) of peak', () => {
    const pk = mfPeaks(m, { fz: m.fz0 });
    expect(pk.y).toBeCloseTo(m.pDy1 * m.fz0, 6);
    expect(pk.x).toBeCloseTo(m.pDx1 * m.fz0, 6);
    expect(mfLateral(m, -3 * DEG, { fz: m.fz0 })).toBeCloseTo(-mfLateral(m, 3 * DEG, { fz: m.fz0 }), 9);
    expect(pk.slideY).toBeCloseTo(Math.sin((m.pCy1 * Math.PI) / 2), 9);
    expect(pk.slideX).toBeCloseTo(Math.sin((m.pCx1 * Math.PI) / 2), 9);
    // Far past the peak the force approaches the sliding share.
    expect(mfLateral(m, 80 * DEG, { fz: m.fz0 }) / pk.y).toBeLessThan(0.95);
    // Small-slip slope = cornering stiffness.
    const h = 1e-5;
    expect(mfLateral(m, h, { fz: m.fz0 }) / h).toBeCloseTo(pk.ky, -1);
  });

  it('load sensitivity: a more loaded tire grips less per newton', () => {
    const lo = mfPeaks(m, { fz: 0.5 * m.fz0 }).y / (0.5 * m.fz0);
    const hi = mfPeaks(m, { fz: 1.5 * m.fz0 }).y / (1.5 * m.fz0);
    expect(lo).toBeGreaterThan(hi);
    expect(lo - hi).toBeCloseTo(-m.pDy2, 6);
  });

  it('camber: leaning into the turn adds thrust up to a best lean, leaning out costs grip', () => {
    const level = mfPeaks(m, { fz: m.fz0 }).y;
    const best = m.pVy3 / (2 * m.pDy1 * m.pDy3);
    const atBest = mfPeaks(m, { fz: m.fz0, gamma: best }).y;
    expect(atBest).toBeGreaterThan(level);
    expect(mfPeaks(m, { fz: m.fz0, gamma: best * 0.8 }).y).toBeLessThan(atBest);
    expect(mfPeaks(m, { fz: m.fz0, gamma: best * 1.2 }).y).toBeLessThan(atBest);
    expect(mfPeaks(m, { fz: m.fz0, gamma: -2 * DEG }).y).toBeLessThan(level);
    // Camber thrust at zero slip.
    expect(mfLateral(m, 0, { fz: m.fz0, gamma: 2 * DEG })).toBeCloseTo(m.pVy3 * 2 * DEG * m.fz0, 6);
  });

  it('slip inverts the curve up to the peak; past it there is no slip that gives the force', () => {
    for (const a of [0.5, 2, 5]) {
      const fy = mfLateral(m, a * DEG, { fz: 800, gamma: 1 * DEG });
      expect(mfSlipAngle(m, fy, { fz: 800, gamma: 1 * DEG }) / DEG).toBeCloseTo(a, 4);
    }
    const fx = mfLongitudinal(m, 0.04, { fz: 800 });
    expect(mfSlipRatio(m, fx, { fz: 800 })).toBeCloseTo(0.04, 5);
    expect(mfSlipAngle(m, mfPeaks(m, { fz: 800 }).y * 1.05, { fz: 800 })).toBeNaN();
    expect(mfPeakSlips(m, { fz: m.fz0 }).alpha / DEG).toBeGreaterThan(3);
  });

  it('more pressure than nominal lowers the peak (ppy3 < 0)', () => {
    expect(mfPeaks(m, { fz: m.fz0, pressure: 1.5 * m.p0 }).y).toBeLessThan(mfPeaks(m, { fz: m.fz0, pressure: m.p0 }).y);
    expect(mfPeaks(m, { fz: m.fz0, pressure: m.p0 }).y).toBeCloseTo(mfPeaks(m, { fz: m.fz0 }).y, 9);
  });
});

const geom = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
const profile = { radius: 260, width: 205, shoulderRadius: 25, rimRadius: 165 };
const gas: TireForceModel = { kind: 'gas', volumeChange: true, volumeFactor: 1, conditions: { setPressure: 83, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 } };
const des = { geometry: geom, profile, model: gas, springRate: SAMPLE_SPRING.rate, freeLength: SAMPLE_SPRING.freeLength, unsprungMass: 12 };
const base = (over: Partial<VehicleProblem> = {}): VehicleProblem => ({
  designs: { FL: des }, roots: { FL: 'FL', FR: 'FL', RL: 'FL', RR: 'FL' },
  settings: { FL: { brake: 'outboard', drive: 'none' }, FR: { brake: 'outboard', drive: 'none' }, RL: { brake: 'outboard', drive: 'chassis' }, RR: { brake: 'outboard', drive: 'chassis' } },
  mass: 300, cg: { x: 0, height: 280, z: -0.47 * 1550 }, wheelbase: 1550, brakeBias: 0.6, driveSplit: 0.5, autoPreload: true,
  shared: { front: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } }, rear: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } } },
  dropLinks: { front: null, rear: null }, droop: 50, bump: 50, cases: { lateralG: 0, brakingG: 0, accelG: 0 }, goals: [], variables: [],
  steering: { steered: { FL: true, FR: true }, rackLimit: 30, cFactor: 75 },
  ...over,
});

describe('Magic Formula in the whole car', () => {
  const p = base();
  const asm = assembleVehicle(p, { FL: geom })!;
  const turn = (lateralG: number) => solveCase(p, asm, { name: 't', kind: 'state', g: lateralG, lateralG, brakingG: 0, accelG: 0 })!.result.grip!;

  it('left and right turns mirror; slip angles grow with cornering; each tire\'s lean counts toward the turn', () => {
    const l = turn(0.6), r = turn(-0.6);
    expect(l.corners.FR.capY).toBeCloseTo(r.corners.FL.capY, 0);
    expect(l.corners.FR.camberToTurn).toBeCloseTo(r.corners.FL.camberToTurn, 3);
    // Lean toward the turn = the solved inclination (+ top outboard) seen from the turn's side:
    // in a left turn the left (inside) wheel's outboard side faces the turn, the right one's faces away.
    const res = solveCase(p, asm, { name: 't', kind: 'state', g: 0.6, lateralG: 0.6, brakingG: 0, accelG: 0 })!.result;
    expect(l.corners.FL.camberToTurn).toBeCloseTo((res.corners.FL.inclination * 180) / Math.PI, 6);
    expect(l.corners.FR.camberToTurn).toBeCloseTo((-res.corners.FR.inclination * 180) / Math.PI, 6);
    const soft = turn(0.3);
    expect(Math.abs(l.corners.FL.slipAngle)).toBeGreaterThan(Math.abs(soft.corners.FL.slipAngle));
    expect(Math.abs(soft.corners.FL.slipAngle)).toBeGreaterThan(0.1);
  });

  it('a turn needs atan(wheelbase ÷ R) plus the front − rear slip angle of steering', () => {
    const seg: SegmentSpec = { distance: 30, v0: 13, v1: 13, path: 'left', radius: 30, grade: 0, bank: 0 };
    const run = runTest(p, { FL: geom }, [seg], { onFail: 'report' });
    const s = run.states[0]!;
    const g = s.grip!.corners;
    const slip = (Math.abs(g.FL.slipAngle) + Math.abs(g.FR.slipAngle)) / 2 - (Math.abs(g.RL.slipAngle) + Math.abs(g.RR.slipAngle)) / 2;
    expect(s.steer!.slip).toBeCloseTo(slip, 3);
    expect(s.steer!.wheelAngle).toBeCloseTo((Math.atan(1.55 / 30) * 180) / Math.PI + slip, 3);
  });
});

describe('Magic Formula in project files', () => {
  it('saves and loads the coefficients; a format-8 friction coefficient μ ≠ 1 scales the peak μ\'s', () => {
    const d = defaultDesign();
    d.tireGrip = { ...d.tireGrip, pVy3: { text: '0.7', value: 0.7 } };
    const back = importProject(JSON.parse(JSON.stringify(serializeProject(d, 'T')))).design;
    expect(back.tireGrip).toEqual(d.tireGrip);
    const old = JSON.parse(JSON.stringify(serializeProject(defaultDesign(), 'Old')));
    old.formatVersion = 8;
    delete old.tireGrip;
    old.grip.muRef = { text: '1.5', value: 1.5 };
    const r = importProject(old).design.tireGrip;
    expect(r.pDy1.value).toBeCloseTo(1.5 * DEFAULT_MF.pDy1, 6);
    expect(r.pDx1.value).toBeCloseTo(1.5 * DEFAULT_MF.pDx1, 6);
    expect(r.pCy1.value).toBe(DEFAULT_MF.pCy1);
  });
});
