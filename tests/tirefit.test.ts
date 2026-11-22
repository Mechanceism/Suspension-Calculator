import { describe, it, expect } from 'vitest';
import { parseTir, parseTireTable, fitTire, writeTir, tirFy0, tirFx0, rng, assembleVehicle, solveCase, type TirModel, type VehicleProblem, type TireForceModel } from '../src/core';
import { SAMPLE_LAYOUTS, SAMPLE_SPRING } from '../src/examples/sampleLayouts';

// A made-up "true" tire to generate measurements from (ISO signs).
const truth: TirModel = {
  kind: 'tir', name: 'truth', fittyp: 61, version: '6.1', fnomin: 1200, nompres: 0,
  p: { PCY1: 1.45, PDY1: 1.6, PDY2: -0.15, PEY1: -0.8, PKY1: -25, PKY2: 1.6, PKY4: 2, PCX1: 1.6, PDX1: 1.7, PDX2: -0.12, PKX1: 28, PEX1: 0.1 },
};

/** A measurement table like an exported test-rig run: degrees, SAE-style negative load. */
function table(noise = 5): string {
  const r = rng(5);
  const rows = ['SA SL FZ IA FX FY', 'deg - N deg N N'];
  for (const fz of [600, 900, 1200, 1500]) {
    for (let a = -12; a <= 12; a += 0.25) {
      const fy = tirFy0(truth, { fz, kappa: 0, alpha: (a * Math.PI) / 180, gamma: 0 }).fy + (r() - 0.5) * 2 * noise;
      rows.push(`${a} 0 ${-fz} 0 0 ${fy.toFixed(2)}`);
    }
    for (let k = -0.2; k <= 0.2; k += 0.005) {
      const fx = tirFx0(truth, { fz, kappa: k, alpha: 0, gamma: 0 }).fx + (r() - 0.5) * 2 * noise;
      rows.push(`0 ${k.toFixed(4)} ${-fz} 0 ${fx.toFixed(2)} 0`);
    }
  }
  return rows.join('\n');
}

describe('fitting a tire model to measured data', () => {
  it('reads a table with a units row; recovers the coefficients; the fit round-trips through a .tir file', () => {
    const csv = parseTireTable(table());
    expect(csv.errors).toEqual([]);
    expect(csv.samples.length).toBeGreaterThan(500);
    expect(csv.samples[0]!.fz).toBeGreaterThan(0); // negative loads read as magnitudes
    const r = fitTire(csv.samples, { name: 'fit.tir' });
    expect(r.lateral!.r2).toBeGreaterThan(0.999);
    expect(r.longitudinal!.r2).toBeGreaterThan(0.999);
    expect(r.lateral!.rmsN).toBeLessThan(10);
    expect(r.model.fnomin).toBe(1200);
    // Same forces as the truth across the range (coefficients can trade off; the curves must match).
    for (const fz of [700, 1200, 1400]) {
      for (const a of [-8, -3, 2, 6]) {
        const t = tirFy0(truth, { fz, kappa: 0, alpha: (a * Math.PI) / 180, gamma: 0 }).fy;
        expect(Math.abs(tirFy0(r.model, { fz, kappa: 0, alpha: (a * Math.PI) / 180, gamma: 0 }).fy - t)).toBeLessThan(0.02 * Math.abs(truth.p.PDY1! * fz));
      }
    }
    const back = parseTir(writeTir(r.model), 'fit.tir').model!;
    expect(back.version).toBe('6.1');
    expect(tirFy0(back, { fz: 1000, kappa: 0, alpha: 0.05, gamma: 0 }).fy).toBeCloseTo(tirFy0(r.model, { fz: 1000, kappa: 0, alpha: 0.05, gamma: 0 }).fy, 3);
    expect(tirFx0(back, { fz: 1000, kappa: 0.05, alpha: 0, gamma: 0 }).fx).toBeCloseTo(tirFx0(r.model, { fz: 1000, kappa: 0.05, alpha: 0, gamma: 0 }).fx, 3);
  });

  it('reports a table it cannot use', () => {
    expect(parseTireTable('a,b,c\n1,2,3').errors.length).toBeGreaterThan(0);
    expect(parseTireTable('SA,SL,FZ\n1,0,-500').errors.join(' ')).toMatch(/force/);
  });
});

describe('different tires front and rear', () => {
  it('the rear corners use the rear tire model', () => {
    const geom = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
    const gas: TireForceModel = { kind: 'gas', volumeChange: true, volumeFactor: 1, conditions: { setPressure: 83, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 } };
    const p: VehicleProblem = {
      designs: { FL: { geometry: geom, profile: { radius: 260, width: 205, shoulderRadius: 25, rimRadius: 165 }, model: gas, springRate: SAMPLE_SPRING.rate, freeLength: SAMPLE_SPRING.freeLength, unsprungMass: 12 } },
      roots: { FL: 'FL', FR: 'FL', RL: 'FL', RR: 'FL' },
      settings: { FL: { brake: 'outboard', drive: 'none' }, FR: { brake: 'outboard', drive: 'none' }, RL: { brake: 'outboard', drive: 'chassis' }, RR: { brake: 'outboard', drive: 'chassis' } },
      mass: 300, cg: { x: 0, height: 280, z: -0.47 * 1550 }, wheelbase: 1550, brakeBias: 0.6, driveSplit: 0.5, autoPreload: true,
      shared: { front: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } }, rear: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } } },
      dropLinks: { front: null, rear: null }, droop: 50, bump: 50, cases: { lateralG: 0, brakingG: 0, accelG: 0 }, goals: [], variables: [],
    };
    const grip = (pp: VehicleProblem) => solveCase(pp, assembleVehicle(pp, { FL: geom })!, { name: 't', kind: 'state', g: 0.5, lateralG: 0.5, brakingG: 0, accelG: 0 })!.result.grip!;
    const same = grip(p);
    const stickyRear = grip({ ...p, tireGripRear: truth });
    expect(stickyRear.corners.FL.capY).toBeCloseTo(same.corners.FL.capY, 0);
    expect(stickyRear.corners.RL.capY).toBeGreaterThan(same.corners.RL.capY * 1.3);
  });
});
