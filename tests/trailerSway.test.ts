import { describe, it, expect } from 'vitest';
import {
  rideRun, runTest, assembleVehicle, steerForTurn, solveCase, slipDifference, steerTable, rackFor, effAt, pathOffset, DEFAULT_MF,
  type VehicleProblem, type TireForceModel, type SegmentSpec,
} from '../src/core';
import { estimateInertia } from '../src/core/setup/measure';
import { SAMPLE_LAYOUTS, SAMPLE_SPRING } from '../src/examples/sampleLayouts';

const geom = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
const profile = { radius: 260, width: 205, shoulderRadius: 25, rimRadius: 165 };
const gas: TireForceModel = { kind: 'gas', volumeChange: true, volumeFactor: 1, conditions: { setPressure: 83, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 } };
const des = { geometry: geom, profile, model: gas, springRate: SAMPLE_SPRING.rate, freeLength: SAMPLE_SPRING.freeLength, unsprungMass: 12, damping: { bump: 1500, rebound: 2500 } };
const base = (over: Partial<VehicleProblem> = {}): VehicleProblem => ({
  designs: { FL: des }, roots: { FL: 'FL', FR: 'FL', RL: 'FL', RR: 'FL' },
  settings: { FL: { brake: 'outboard', drive: 'none' }, FR: { brake: 'outboard', drive: 'none' }, RL: { brake: 'outboard', drive: 'chassis' }, RR: { brake: 'outboard', drive: 'chassis' } },
  mass: 300, cg: { x: 0, height: 280, z: -0.47 * 1550 }, wheelbase: 1550, brakeBias: 0.6, driveSplit: 0.5, autoPreload: true,
  shared: { front: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } }, rear: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } } },
  dropLinks: { front: null, rear: null }, droop: 50, bump: 50, cases: { lateralG: 0, brakingG: 0, accelG: 0 }, goals: [], variables: [],
  steering: { steered: { FL: true, FR: true }, rackLimit: 30, cFactor: 75 },
  ride: { rollInertia: 35, pitchInertia: 100, tireDamping: 100 },
  tireGrip: DEFAULT_MF,
  ...over,
});
const seg = (path: 'left' | 'right' | 'straight', radius: number, distance: number, v: number, v1 = v): SegmentSpec => ({ distance, v0: v, v1, path, radius, grade: 0, bank: 0 });
const G = 9.80665;
const trailer = (tongueShare: number, mass = 200) => ({ mass, tongueShare, hitchHeight: 450, hitchBehindRear: 900, hitchToAxle: 3000, cgHeight: 700, brakeShare: 0, yawRadius: 1200 });
// Straight, an S-bend (R 150 m left then right), then a long straight to watch the trailer settle.
const sBend = (v: number) => [seg('straight', 0, 30, v), seg('left', 150, 25, v), seg('right', 150, 25, v), seg('straight', 0, 200, v)];
const run = (tau: number, v: number, mass = 200) => rideRun(base({ trailer: trailer(tau, mass) }), { FL: geom }, sBend(v), { handling: true });

describe('trailer sway (handling over time)', () => {
  it('a well-loaded trailer at a moderate speed follows, swings a little and settles', () => {
    const r = run(0.12, 15);
    expect(r.error).toBeUndefined();
    expect(r.metrics.maxSway!).toBeLessThan(2.5);
    expect(Math.abs(r.frames.at(-1)!.handling!.trailer!.articulation)).toBeLessThan(0.1);
    expect(r.findings.flat().filter((f) => f.check === 'trailerSway')).toEqual([]);
  });

  it('in a long slow turn the trailer sits at the kinematic articulation', () => {
    const R = 40, k = 1 / R;
    const r = rideRun(base({ trailer: trailer(0.12) }), { FL: geom }, [seg('straight', 0, 10, 4.5), seg('left', R, 80, 4.5)], { handling: true });
    const f = r.frames.at(-1)!;
    // No slip at the rear axle or the trailer's: sin φ + c κ cos φ = −L_t κ, c = hitch behind the rear axle (0.9 m).
    const c = 0.9, L = 3;
    const want = (-Math.asin((L * k) / Math.hypot(1, c * k)) - Math.atan(c * k)) * 180 / Math.PI;
    expect(f.handling!.trailer!.articulation).toBeLessThan(0);
    expect(Math.abs(f.handling!.trailer!.articulation - want) / Math.abs(want)).toBeLessThan(0.1);
  });

  it('less tongue weight or more speed sways more; a light tongue at speed fails (and jackknifes)', () => {
    const good = run(0.12, 22).metrics.maxSway!, light = run(0.02, 22).metrics.maxSway!;
    expect(light).toBeGreaterThan(good);
    expect(run(0.12, 25).metrics.maxSway!).toBeGreaterThan(run(0.12, 15).metrics.maxSway!);
    const bad = run(-0.05, 25);
    const sway = bad.findings.flat().filter((f) => f.check === 'trailerSway');
    expect(sway.length).toBeGreaterThan(0);
    expect(bad.frames.some((f) => Math.abs(f.handling!.trailer!.articulation) > 30)).toBe(true); // jackknifed
    // A run without handling has no trailer body (static towing only).
    expect(rideRun(base({ trailer: trailer(-0.05) }), { FL: geom }, sBend(25), {}).frames.some((f) => f.handling?.trailer)).toBe(false);
  });
});

describe('trailer yaw radius in the app', () => {
  it('older files with a trailer load quietly with the default', async () => {
    const { defaultDesign } = await import('../src/app/store');
    const { serializeProject, importProject } = await import('../src/app/project');
    const d = defaultDesign();
    d.tow = { ...d.tow, on: true, trailerYawRadius: { text: '1600', value: 1600 } };
    expect(importProject(JSON.parse(JSON.stringify(serializeProject(d, 'T')))).design.tow.trailerYawRadius.value).toBe(1600);
    const old = JSON.parse(JSON.stringify(serializeProject(d, 'Old')));
    old.formatVersion = 25;
    delete old.tow.fields.trailerYawRadius;
    const o = importProject(old);
    expect(o.design.tow.trailerYawRadius.value).toBe(1350);
    expect(o.warnings.filter((w: string) => !w.startsWith('Upgraded'))).toEqual([]);
  });
});
