import { describe, it, expect } from 'vitest';
import { rideRun, DEFAULT_MF, type VehicleProblem, type TireForceModel, type SegmentSpec } from '../src/core';
import { SAMPLE_LAYOUTS, SAMPLE_SPRING } from '../src/examples/sampleLayouts';

const geom = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
const gas: TireForceModel = { kind: 'gas', volumeChange: true, volumeFactor: 1, conditions: { setPressure: 83, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 } };
const base = (_r?: number): VehicleProblem => ({
  designs: { FL: { geometry: geom, profile: { radius: 260, width: 205, shoulderRadius: 25, rimRadius: 165 }, model: gas, springRate: SAMPLE_SPRING.rate, freeLength: SAMPLE_SPRING.freeLength, unsprungMass: 12, damping: { bump: 1500, rebound: 2500 } } },
  roots: { FL: 'FL', FR: 'FL', RL: 'FL', RR: 'FL' },
  settings: { FL: { brake: 'outboard', drive: 'none' }, FR: { brake: 'outboard', drive: 'none' }, RL: { brake: 'outboard', drive: 'chassis' }, RR: { brake: 'outboard', drive: 'chassis' } },
  mass: 300, cg: { x: 0, height: 280, z: -0.47 * 1550 }, wheelbase: 1550, brakeBias: 0.6, driveSplit: 0.5, autoPreload: true,
  shared: { front: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } }, rear: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } } },
  dropLinks: { front: null, rear: null }, droop: 50, bump: 50, cases: { lateralG: 0, brakingG: 0, accelG: 0 }, goals: [], variables: [],
  steering: { steered: { FL: true, FR: true }, rackLimit: 30, cFactor: 75 },
  ride: { rollInertia: 35, pitchInertia: 100, tireDamping: 100 },
  tireGrip: DEFAULT_MF,
});
const seg = (path: 'left' | 'straight', radius: number, distance: number, v: number): SegmentSpec => ({ distance, v0: v, v1: v, path, radius, grade: 0, bank: 0 });
const run = (relax?: number) => rideRun(base(relax), { FL: geom }, [seg('straight', 0, 20, 14), seg('left', 40, 120, 14)], { handling: true });
import { aeroForces, type AeroModel } from '../src/core';

const m: AeroModel = { name: 't', CdA: 1, ClAf: -1, ClAr: -1.5, rideHeightRef: 'absolute', dragHeight: 400, CsA: 0.03, sideCp: 1100, rollSens: { front: 0.05, rear: 0.05 }, yawBalance: 0.01 };
const at = (roll = 0, sideslip = 0) => aeroForces({ model: m, rho: 1.2, speed: 30 }, { front: 0, rear: 0 }, { front: 0, rear: 0 }, { roll, sideslip });

describe('aero: side force, roll sensitivity, moving center of pressure', () => {
  it('roll costs downforce, sideslip moves the balance and pushes back against the slide', () => {
    const q = 0.5 * 1.2 * 900;
    const r0 = at(), r2 = at((2 * Math.PI) / 180), b5 = at(0, (5 * Math.PI) / 180);
    expect(r0.liftF).toBeCloseTo(-q, 6);
    expect(r2.liftF).toBeCloseTo(-q * (1 - 0.1), 6); // 2° × 0.05 m²/° lost
    expect(r2.liftR).toBeCloseTo(-q * (1.5 - 0.1), 6);
    const share = (r: typeof r0) => r.liftF / (r.liftF + r.liftR);
    expect(share(b5) - share(r0)).toBeCloseTo(0.05, 9);
    expect(b5.side).toBeCloseTo(-q * 0.03 * 5, 6); // against a slide toward the left
    expect(at().side).toBeCloseTo(0, 12);
  });
  it('in a driven turn a strong side force behind the CG lowers the sideslip', () => {
    const segs = [seg('straight', 0, 20, 18), seg('left', 50, 80, 18)];
    const aero = (CsA: number) => ({ ...base(), aero: { model: { name: 'a', CdA: 0, ClAf: 0, ClAr: 0, rideHeightRef: 'absolute' as const, dragHeight: 400, CsA, sideCp: 1500 }, rho: 1.2 } });
    const none = rideRun(aero(0), { FL: geom }, segs, { handling: true });
    const strong = rideRun(aero(0.5), { FL: geom }, segs, { handling: true });
    const beta = (r: ReturnType<typeof rideRun>) => Math.abs(r.frames.at(-1)!.handling!.sideslip);
    expect(beta(strong)).toBeLessThan(beta(none));
  });
  it('older files load quietly with these off', async () => {
    const { defaultDesign } = await import('../src/app/store');
    const { serializeProject, importProject } = await import('../src/app/project');
    const old = JSON.parse(JSON.stringify(serializeProject(defaultDesign(), 'O')));
    old.formatVersion = 34;
    for (const k of ['CsA', 'sideCp', 'rollSensF', 'rollSensR', 'yawBalance']) delete old.aero.fields[k];
    const o = importProject(old);
    expect(o.warnings.filter((w: string) => !w.startsWith('Upgraded'))).toEqual([]);
    expect(o.design.aero.CsA.value).toBe(0);
  });
});
