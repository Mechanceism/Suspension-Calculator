import { describe, it, expect } from 'vitest';
import { assembleVehicle, solveCase, aeroCoefficients, parseAero, airDensity, type VehicleProblem, type TireForceModel, type AeroModel } from '../src/core';
import { SAMPLE_LAYOUTS, SAMPLE_SPRING } from '../src/examples/sampleLayouts';

const geom = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
const gas: TireForceModel = { kind: 'gas', volumeChange: true, volumeFactor: 1, conditions: { setPressure: 83, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 } };
const base = (over: Partial<VehicleProblem> = {}): VehicleProblem => ({
  designs: { FL: { geometry: geom, profile: { radius: 260, width: 205, shoulderRadius: 25, rimRadius: 165 }, model: gas, springRate: SAMPLE_SPRING.rate, freeLength: SAMPLE_SPRING.freeLength, unsprungMass: 12 } },
  roots: { FL: 'FL', FR: 'FL', RL: 'FL', RR: 'FL' },
  settings: { FL: { brake: 'outboard', drive: 'none' }, FR: { brake: 'outboard', drive: 'none' }, RL: { brake: 'outboard', drive: 'chassis' }, RR: { brake: 'outboard', drive: 'chassis' } },
  mass: 300, cg: { x: 0, height: 280, z: -0.47 * 1550 }, wheelbase: 1550, brakeBias: 0.6, driveSplit: 0.5, autoPreload: true,
  shared: { front: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } }, rear: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } } },
  dropLinks: { front: null, rear: null }, droop: 50, bump: 50, cases: { lateralG: 0, brakingG: 0, accelG: 0 }, goals: [], variables: [],
  ...over,
});
const model: AeroModel = { name: 'wing', CdA: 1.0, ClAf: -1.0, ClAr: -1.5, rideHeightRef: 'absolute', dragHeight: 500 };
const sum = (r: ReturnType<typeof solveCase>) => ['FL', 'FR', 'RL', 'RR'].reduce((a, id) => a + r!.result.corners[id as 'FL'].tireLoad, 0);

describe('aerodynamics', () => {
  it('downforce adds to the tire loads (split by axle); drag needs drive and moves load rearward', () => {
    const plain = base();
    const withAero = base({ aero: { model, rho: 1.2 } });
    const asmA = assembleVehicle(plain, { FL: geom })!, asmB = assembleVehicle(withAero, { FL: geom })!;
    const V = 30, q = 0.5 * 1.2 * V * V;
    const a = solveCase(plain, asmA, { name: 's', kind: 'state', g: 0, lateralG: 0, brakingG: 0, accelG: 0, speed: V } as never)!;
    const b = solveCase(withAero, asmB, { name: 's', kind: 'state', g: 0, lateralG: 0, brakingG: 0, accelG: 0, speed: V } as never)!;
    expect(sum(b) - sum(a)).toBeCloseTo(q * 2.5, 0);
    const front = (r: typeof a) => r.result.corners.FL.tireLoad + r.result.corners.FR.tireLoad;
    // Front gains ~ its downforce minus the rearward shift from drag at 500 mm.
    const shift = (q * 1.0 * (500 + 0)) / 1550;
    expect(front(b) - front(a)).toBeGreaterThan(q * 1.0 - shift - 60);
    expect(front(b) - front(a)).toBeLessThan(q * 1.0);
    // Constant speed: the driven tires push exactly the drag.
    const drive = b.result.corners.RL.driveForce + b.result.corners.RR.driveForce;
    expect(drive).toBeCloseTo(q * 1.0, 0);
    expect(b.result.aero!.drag).toBeCloseTo(q, 6);
    expect(b.result.aero!.liftF + b.result.aero!.liftR).toBeLessThan(0);
  });

  it('maps interpolate over front / rear ride height; files read as JSON or CSV', () => {
    const map: AeroModel = { ...model, map: { rhFront: [40, 60], rhRear: [50, 70], CdA: [[1, 1.2], [1.1, 1.3]], ClAf: [[-2, -1.8], [-1.6, -1.4]], ClAr: [[-2, -2.2], [-1.8, -2]] } };
    const mid = aeroCoefficients(map, 50, 60);
    expect(mid.CdA).toBeCloseTo(1.15, 9);
    expect(mid.ClAf).toBeCloseTo(-1.7, 9);
    expect(mid.ClAr).toBeCloseTo(-2, 9);
    expect(aeroCoefficients(map, 0, 0).ClAf).toBe(-2); // held at the edge
    const j = parseAero(JSON.stringify({ format: 'suspension-aero', version: 1, name: 'cfd', CdA: 0.8, ClA: -2, balance: 0.4, dragHeight: 420 }));
    expect(j.model).toMatchObject({ name: 'cfd', CdA: 0.8, dragHeight: 420 });
    expect(j.model!.ClAf).toBeCloseTo(-0.8, 9);
    expect(j.model!.ClAr).toBeCloseTo(-1.2, 9);
    const csv = 'rhF,rhR,CdA,ClAf,ClAr\n40,50,1,-2,-2\n40,70,1.2,-1.8,-2.2\n60,50,1.1,-1.6,-1.8\n60,70,1.3,-1.4,-2';
    const c = parseAero(csv, 'grid.csv');
    expect(c.model!.map!.rhFront).toEqual([40, 60]);
    expect(aeroCoefficients(c.model!, 50, 60).ClAf).toBeCloseTo(-1.7, 9);
    expect(parseAero('rhF,rhR,CdA\n1,2,3').errors.length).toBeGreaterThan(0);
    expect(parseAero('{"map": {"rhFront": [1,2]}}').errors.length).toBeGreaterThan(0);
    expect(airDensity(0, 15)).toBeCloseTo(1.225, 3);
  });
});
