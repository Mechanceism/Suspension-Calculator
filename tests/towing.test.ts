import { describe, it, expect } from 'vitest';
import { hitchForce, assembleVehicle, solveCase, rideRun, DEFAULT_MF, type TrailerSpec, type VehicleProblem, type TireForceModel } from '../src/core';
import { SAMPLE_LAYOUTS, SAMPLE_SPRING } from '../src/examples/sampleLayouts';

const G = 9.80665;
const trailer: TrailerSpec = { mass: 400, tongueShare: 0.1, hitchHeight: 450, hitchBehindRear: 900, hitchToAxle: 3000, cgHeight: 700, brakeShare: 0 };
const geom = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
const gas: TireForceModel = { kind: 'gas', volumeChange: true, volumeFactor: 1, conditions: { setPressure: 83, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 } };
const base = (over: Partial<VehicleProblem> = {}): VehicleProblem => ({
  designs: { FL: { geometry: geom, profile: { radius: 260, width: 205, shoulderRadius: 25, rimRadius: 165 }, model: gas, springRate: SAMPLE_SPRING.rate, freeLength: SAMPLE_SPRING.freeLength, unsprungMass: 12, damping: { bump: 1500, rebound: 2500 } } },
  roots: { FL: 'FL', FR: 'FL', RL: 'FL', RR: 'FL' },
  settings: { FL: { brake: 'outboard', drive: 'none' }, FR: { brake: 'outboard', drive: 'none' }, RL: { brake: 'outboard', drive: 'chassis' }, RR: { brake: 'outboard', drive: 'chassis' } },
  mass: 300, cg: { x: 0, height: 280, z: -0.47 * 1550 }, wheelbase: 1550, brakeBias: 0.6, driveSplit: 0.5, autoPreload: true,
  shared: { front: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } }, rear: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } } },
  dropLinks: { front: null, rear: null }, droop: 50, bump: 50, cases: { lateralG: 0, brakingG: 0, accelG: 0 }, goals: [], variables: [],
  steering: { steered: { FL: true, FR: true }, rackLimit: 30, cFactor: 75 }, ride: { rollInertia: 35, pitchInertia: 100, tireDamping: 100 }, tireGrip: DEFAULT_MF,
  ...over,
});
const sum = (r: { corners: Record<string, { tireLoad: number }> }) => Object.values(r.corners).reduce((a, c) => a + c.tireLoad, 0);

describe('towing (static)', () => {
  it('hitch forces from the trailer balance', () => {
    const s = hitchForce(trailer, 0, 0);
    expect(s.y).toBeCloseTo(-400 * G * 0.1, 6); // tongue weight
    expect(s.x).toBe(-0); expect(s.z).toBe(-0);
    const turn = hitchForce(trailer, 0.5, 0);
    expect(turn.x).toBeCloseTo(-400 * 0.5 * G * 0.1, 6); // pulls the hitch outward
    // Braking with no trailer brakes: the trailer pushes the car and loads the hitch more (CG above the hitch).
    const brk = hitchForce(trailer, 0, -0.5);
    expect(brk.z).toBeCloseTo(400 * 0.5 * G, 6);
    expect(-brk.y).toBeGreaterThan(-s.y);
    // Its own brakes take that push away.
    expect(hitchForce({ ...trailer, brakeShare: 1 }, 0, -0.5).z).toBeCloseTo(0, 9);
  });

  it('the tongue weight loads the rear tires; braking needs more from the car; cornering more side grip at the rear', () => {
    const plain = base(), tow = base({ trailer });
    const solve = (p: VehicleProblem, c: { lateralG: number; brakingG: number }) => solveCase(p, assembleVehicle(p, { FL: geom })!, { name: 'c', kind: 'state', g: 0, accelG: 0, ...c })!.result;
    const a = solve(plain, { lateralG: 0, brakingG: 0 }), b = solve(tow, { lateralG: 0, brakingG: 0 });
    expect(sum(b) - sum(a)).toBeCloseTo(400 * G * 0.1, 0);
    // The hitch is behind the rear axle: the rear gains more than the tongue weight, the front loses some.
    expect(b.corners.RL.tireLoad + b.corners.RR.tireLoad - a.corners.RL.tireLoad - a.corners.RR.tireLoad).toBeGreaterThan(400 * G * 0.1);
    expect(b.corners.FL.tireLoad).toBeLessThan(a.corners.FL.tireLoad);
    expect(b.hitch).toBeDefined();
    // Braking 0.5 g: the car's brakes stop the trailer too.
    const bb = solve(tow, { lateralG: 0, brakingG: 0.5 }), ba = solve(plain, { lateralG: 0, brakingG: 0.5 });
    const brake = (r: typeof bb) => -Object.values(r.corners).reduce((x, c) => x + c.brakeForce, 0);
    expect(brake(bb) - brake(ba)).toBeCloseTo(400 * 0.5 * G, 0);
    // Cornering 0.5 g: the tires give the trailer's tongue share too, mostly at the rear.
    const lt = solve(tow, { lateralG: 0.5, brakingG: 0 }), lp = solve(plain, { lateralG: 0.5, brakingG: 0 });
    const lat = (r: typeof lt, ids: string[]) => ids.reduce((x, id) => x + Math.abs(r.corners[id as 'FL'].lateralForce), 0);
    expect(lat(lt, ['FL', 'FR', 'RL', 'RR']) - lat(lp, ['FL', 'FR', 'RL', 'RR'])).toBeCloseTo(400 * 0.5 * G * 0.1, 0);
    expect(lat(lt, ['RL', 'RR']) - lat(lp, ['RL', 'RR'])).toBeGreaterThan(400 * 0.5 * G * 0.1);
  });

  it('drives a test towing, with handling', () => {
    const r = rideRun(base({ trailer }), { FL: geom }, [
      { distance: 15, v0: 12, v1: 12, path: 'straight', radius: 0, grade: 0, bank: 0 },
      { distance: 50, v0: 12, v1: 12, path: 'left', radius: 30, grade: 0, bank: 0 },
    ], { handling: true });
    expect(r.error).toBeUndefined();
    expect(r.metrics.maxPathError!).toBeLessThan(0.6);
    expect(r.findings.flat().filter((f) => f.check === 'noSolution')).toEqual([]);
  });
});
