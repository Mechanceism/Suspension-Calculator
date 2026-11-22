import { describe, it, expect } from 'vitest';
import {
  parseTir, tirFy0, tirFx0, tirForces, mfPeaks, mfSlipAngle, mfLateral, assembleVehicle, solveCase,
  type TirModel, type VehicleProblem, type TireForceModel,
} from '../src/core';
import { SAMPLE_LAYOUTS, SAMPLE_SPRING } from '../src/examples/sampleLayouts';
import { defaultDesign } from '../src/app/store';
import { serializeProject, importProject } from '../src/app/project';

// A small synthetic MF 6.1 file (made-up values, ISO signs: positive slip angle → negative side force).
const TIR = `[MDI_HEADER]
FILE_TYPE                = 'tir'
$ a comment line
[UNITS]
LENGTH                   = 'meter'
FORCE                    = 'newton'
ANGLE                    = 'radians'
[MODEL]
FITTYP                   = 61        $ MF 6.1
[DIMENSION]
UNLOADED_RADIUS          = 0.26
[OPERATING_CONDITIONS]
NOMPRES                  = 100000
[VERTICAL]
FNOMIN                   = 1000
[LONGITUDINAL_COEFFICIENTS]
PCX1 = 1.6
PDX1 = 1.2
PDX2 = -0.1
PKX1 = 25
PEX1 = 0
[LATERAL_COEFFICIENTS]
PCY1 = 1.4
PDY1 = 1.1
PDY2 = -0.1
PDY3 = 5
PEY1 = -0.5
PKY1 = -20
PKY2 = 1.8
PKY4 = 2
PKY6 = 1.0
PVY3 = 0.0
PPY3 = -0.2
[COMBINED]
RBY1 = 10
RCY1 = 1.0
RBX1 = 12
RCX1 = 1.0
`;

const model = () => parseTir(TIR, 'synthetic.tir').model!;
const DEG = Math.PI / 180;

describe('.tir files', () => {
  it('reads sections, comments and units; reports what is missing', () => {
    const r = parseTir(TIR, 'synthetic.tir');
    expect(r.errors).toEqual([]);
    expect(r.model).toMatchObject({ kind: 'tir', fittyp: 61, version: '6.1', fnomin: 1000, nompres: 100 });
    expect(r.model!.p.PKY1).toBe(-20);
    const mm = parseTir(TIR.replace("LENGTH                   = 'meter'", "LENGTH = 'mm'").replace("FORCE                    = 'newton'", "FORCE = 'kN'").replace('FNOMIN                   = 1000', 'FNOMIN = 1.0').replace('NOMPRES                  = 100000', 'NOMPRES = 0.0001'));
    expect(mm.model!.fnomin).toBeCloseTo(1000, 6);
    expect(mm.model!.nompres).toBeCloseTo(100, 6);
    expect(mm.warnings.join(' ')).toMatch(/converted/);
    const bad = parseTir(TIR.replace('FNOMIN                   = 1000', '').replace('PDY1 = 1.1', ''));
    expect(bad.model).toBeNull();
    expect(bad.errors.join(' ')).toMatch(/FNOMIN/);
    expect(bad.errors.join(' ')).toMatch(/PDY1/);
  });

  it('pure side force follows the MF 6.1 equations (no shifts here)', () => {
    const m = model();
    const fz = 1000, a = 3 * DEG;
    const C = 1.4, D = 1.1 * fz;
    const K = -20 * 1000 * Math.sin(2 * Math.atan(fz / (1.8 * 1000)));
    const B = K / (C * D);
    // E depends on the sign of α (PEY3 = 0 here, so it doesn't).
    const E = -0.5;
    const expected = D * Math.sin(C * Math.atan(B * a - E * (B * a - Math.atan(B * a))));
    expect(tirFy0(m, { fz, kappa: 0, alpha: a, gamma: 0 }).fy).toBeCloseTo(expected, 6);
    expect(expected).toBeLessThan(0); // ISO: positive slip angle, negative force
    // Camber stiffness PKY6: thrust at zero slip ≈ PKY6·Fz·γ.
    expect(tirFy0(m, { fz, kappa: 0, alpha: 0, gamma: 0.02 }).fy).toBeCloseTo(1.0 * fz * Math.sin(0.02), 0);
  });

  it('the car sees positive peaks toward the push direction; peak = D at Fz0; inversion round-trips', () => {
    const m = model();
    const pk = mfPeaks(m, { fz: 1000 });
    expect(pk.y).toBeCloseTo(1100, 0);
    expect(pk.x).toBeCloseTo(1200, 0);
    // Sliding share: the force at a large slip angle (69°) ÷ peak, between the far-off limit sin(C·π/2) and 1.
    expect(pk.slideY).toBeGreaterThan(Math.sin((1.4 * Math.PI) / 2));
    expect(pk.slideY).toBeLessThan(0.95);
    expect(mfLateral(m, 4 * DEG, { fz: 1000 })).toBeGreaterThan(0);
    const f = mfLateral(m, 2.5 * DEG, { fz: 1000 });
    expect(mfSlipAngle(m, f, { fz: 1000 }) / DEG).toBeCloseTo(2.5, 2);
    // Cached peaks (table) agree with a direct scan within 1 %.
    const direct = Math.max(...Array.from({ length: 400 }, (_, i) => mfLateral(m, (i / 400) * 0.6, { fz: 1730, gamma: 0.03 })));
    expect(mfPeaks(m, { fz: 1730, gamma: 0.03 }).y / direct).toBeCloseTo(1, 2);
    // More pressure than nominal lowers the peak (PPY3 < 0).
    expect(mfPeaks(m, { fz: 1000, pressure: 150 }).y).toBeLessThan(pk.y);
  });

  it('combined slip: braking takes side force away, cornering takes braking force away', () => {
    const m = model();
    const at = (kappa: number, alpha: number) => tirForces(m, { fz: 1000, kappa, alpha, gamma: 0 });
    expect(at(0, 4 * DEG).fy).toBeCloseTo(tirFy0(m, { fz: 1000, kappa: 0, alpha: 4 * DEG, gamma: 0 }).fy, 6);
    expect(Math.abs(at(0.1, 4 * DEG).fy)).toBeLessThan(Math.abs(at(0, 4 * DEG).fy));
    expect(Math.abs(at(0.06, 6 * DEG).fx)).toBeLessThan(Math.abs(tirFx0(m, { fz: 1000, kappa: 0.06, alpha: 0, gamma: 0 }).fx));
  });

  it('picks the equations by content: MF 6 coefficients mean 6.1 even with FITTYP 6; PHY3 means 5.2', () => {
    expect(parseTir(TIR.replace('FITTYP                   = 61        $ MF 6.1', 'FITTYP = 6')).model!.version).toBe('6.1');
    const v52 = parseTir(TIR.replace('FITTYP                   = 61        $ MF 6.1', 'FITTYP = 52').replace('PKY4 = 2\nPKY6 = 1.0', 'PHY3 = 0.01').replace('PPY3 = -0.2', ''));
    expect(v52.model!.version).toBe('5.2');
    // MF 5.2: camber shifts the curve sideways by PHY3·γ.
    const m = v52.model!;
    expect(tirFy0(m, { fz: 1000, kappa: 0, alpha: 0, gamma: 0.1 }).fy).not.toBeCloseTo(0, 0);
  });

  it('the whole car runs on a file model', () => {
    const geom = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
    const gas: TireForceModel = { kind: 'gas', volumeChange: true, volumeFactor: 1, conditions: { setPressure: 100, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 } };
    const p: VehicleProblem = {
      designs: { FL: { geometry: geom, profile: { radius: 260, width: 205, shoulderRadius: 25, rimRadius: 165 }, model: gas, springRate: SAMPLE_SPRING.rate, freeLength: SAMPLE_SPRING.freeLength, unsprungMass: 12 } },
      roots: { FL: 'FL', FR: 'FL', RL: 'FL', RR: 'FL' },
      settings: { FL: { brake: 'outboard', drive: 'none' }, FR: { brake: 'outboard', drive: 'none' }, RL: { brake: 'outboard', drive: 'chassis' }, RR: { brake: 'outboard', drive: 'chassis' } },
      mass: 300, cg: { x: 0, height: 280, z: -0.47 * 1550 }, wheelbase: 1550, brakeBias: 0.6, driveSplit: 0.5, autoPreload: true,
      shared: { front: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } }, rear: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } } },
      dropLinks: { front: null, rear: null }, droop: 50, bump: 50, cases: { lateralG: 0, brakingG: 0, accelG: 0 }, goals: [], variables: [],
      tireGrip: model(),
    };
    const asm = assembleVehicle(p, { FL: geom })!;
    const g = solveCase(p, asm, { name: 't', kind: 'state', g: 0.6, lateralG: 0.6, brakingG: 0, accelG: 0 })!.result.grip!;
    expect(g.passed).toBe(true);
    for (const id of ['FL', 'FR', 'RL', 'RR'] as const) {
      expect(g.corners[id].capY).toBeGreaterThan(0);
      expect(Math.abs(g.corners[id].slipAngle)).toBeGreaterThan(0.1);
    }
  });

  it('a loaded tire file saves with the project (format 12); older files use the simple model', () => {
    const d = defaultDesign();
    d.tireFile = { ...model(), p: { ...model().p, LMUY: 0.7 } } as TirModel;
    const back = importProject(JSON.parse(JSON.stringify(serializeProject(d, 'T')))).design;
    expect(back.tireFile).toMatchObject({ kind: 'tir', name: 'synthetic.tir', version: '6.1', fnomin: 1000 });
    expect(back.tireFile!.p.LMUY).toBe(0.7);
    const old = JSON.parse(JSON.stringify(serializeProject(defaultDesign(), 'Old')));
    old.formatVersion = 11;
    delete old.tireFile;
    expect(importProject(old).design.tireFile).toBeNull();
  });
});
