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

import { runTest } from '../src/core/tests/run';

const stop = { distance: 30, v0: 15, v1: 5, path: 'straight' as const, radius: 0, grade: 0, bank: 0 };
const flat = { distance: 20, v0: 10, v1: 10, path: 'straight' as const, radius: 0, grade: 0, bank: 0 };

describe('tongue weight checks', () => {
  it('a hitch rated just above the static tongue load is overloaded when braking pushes it down', () => {
    const staticLoad = 400 * G * 0.1; // 392 N
    const p = base({ trailer: { ...trailer, tongueLimit: staticLoad * 1.1 } });
    const cruise = runTest(p, { FL: geom }, [flat], { onFail: 'report' });
    expect(cruise.segments[0]!.findings.filter((f) => f.check === 'hitchLoad')).toEqual([]);
    const braking = runTest(p, { FL: geom }, [stop], { onFail: 'report' });
    const h = braking.segments[0]!.findings.filter((f) => f.check === 'hitchLoad');
    expect(h.length).toBeGreaterThan(0);
    expect(h[0]!.severity).toBe('fail');
    // No rating: no check.
    expect(runTest(base({ trailer }), { FL: geom }, [stop], { onFail: 'report' }).segments[0]!.findings.some((f) => f.check === 'hitchLoad')).toBe(false);
  });
  it('warns of a light tongue (sway risk) below the threshold', () => {
    const light = runTest(base({ trailer: { ...trailer, tongueShare: 0.05 } }), { FL: geom }, [flat], { onFail: 'report' });
    expect(light.segments[0]!.findings.some((f) => f.check === 'lightTongue' && f.severity === 'warn')).toBe(true);
    expect(runTest(base({ trailer }), { FL: geom }, [flat], { onFail: 'report' }).segments[0]!.findings.some((f) => f.check === 'lightTongue')).toBe(false);
  });
});
