import { describe, it, expect } from 'vitest';
import {
  gaussLegendre, integrateCosineMap, localPatch, contactPatch, airVolume, sliceRadius,
  tireForce, solveLoadedHeight, ambientPressure, parseTireSize,
  vec3, dot, sub, type TireProfile, type TireForceModel,
} from '../src/core';

const sharp: TireProfile = { radius: 260, width: 200, shoulderRadius: 0, rimRadius: 165 };
const rounded: TireProfile = { ...sharp, shoulderRadius: 30 };
const segment = (R: number, d: number) => R * R * Math.acos(d / R) - d * Math.sqrt(R * R - d * d);

/**
 * Independent area check: sample a fine grid on the ground plane and count points that lie inside
 * the tire solid. Works directly in tire coordinates: axle along x, wheel center at the origin.
 */
function bruteForceArea(p: TireProfile, h0: number, tilt: number, step = 0.25): number {
  const cosG = Math.sqrt(1 - tilt * tilt);
  // Ground plane: points g(u, v) = base + u·e1 + v·e2, where e1 = in-plane lateral, e2 = rolling.
  // Ground normal n = (sinG, cosG, 0) in (axle, up-in-wheel-plane, rolling) coordinates.
  const n = [tilt, cosG, 0];
  const e1 = [cosG, -tilt, 0];
  const base = [-n[0]! * h0, -n[1]! * h0, 0];
  let count = 0;
  const U = p.width / cosG + 40;
  const V = 2 * p.radius;
  for (let u = -U; u <= U; u += step) {
    for (let v = -V / 2; v <= V / 2; v += step) {
      const x = base[0]! + u * e1[0]!;
      const y = base[1]! + u * e1[1]!;
      const z = v;
      if (Math.abs(x) > p.width / 2) continue;
      if (y * y + z * z <= sliceRadius(p, x) ** 2) count++;
    }
  }
  return count * step * step;
}

describe('quadrature', () => {
  it('Gauss–Legendre integrates polynomials exactly', () => {
    const { x, w } = gaussLegendre(24);
    const s = x.reduce((acc, xi, i) => acc + w[i]! * xi ** 10, 0);
    expect(s).toBeCloseTo(2 / 11, 13);
  });
  it('cosine map handles square-root endpoints (half-disk area)', () => {
    const [a] = integrateCosineMap(-1, 1, 1, (s, out) => { out[0] = Math.sqrt(Math.max(0, 1 - s * s)); });
    expect(a!).toBeCloseTo(Math.PI / 2, 9);
  });
});

describe('slice-method contact patch', () => {
  it('level tire matches the rectangle and segment formulas exactly', () => {
    const lp = localPatch(sharp, 250, 0);
    expect(lp.inContact).toBe(true);
    expect(lp.area).toBeCloseTo(200 * 2 * Math.sqrt(260 ** 2 - 250 ** 2), 6);
    expect(lp.volume).toBeCloseTo(200 * segment(260, 250), 4);
    expect(lp.centroidS).toBeCloseTo(0, 9);
    expect(lp.centroidD).toBeCloseTo(250, 9);
    expect(lp.penetration).toBeCloseTo(10, 9);
    expect(lp.length).toBeCloseTo(2 * Math.sqrt(260 ** 2 - 250 ** 2), 9);
  });

  it('tilted patch area matches an independent ground-plane grid count', () => {
    for (const [p, h0, tilt] of [[sharp, 245, Math.sin(0.03)], [sharp, 255, Math.sin(-0.05)], [rounded, 250, Math.sin(0.04)]] as const) {
      const lp = localPatch(p, h0, tilt);
      const bf = bruteForceArea(p, h0, tilt);
      expect(Math.abs(lp.area - bf) / bf).toBeLessThan(0.01);
    }
  });

  it('partial-width contact (one edge lifted) shifts the centroid toward the loaded edge', () => {
    // Axle tilted so the outboard (+s) side is higher: contact only on the inboard side.
    const lp = localPatch(sharp, 258, Math.sin(0.05));
    expect(lp.inContact).toBe(true);
    expect(lp.sMax).toBeLessThan(100);
    expect(lp.centroidS).toBeLessThan(0);
  });

  it('is continuous through zero inclination (no rectangle/ellipse case split)', () => {
    const a0 = localPatch(rounded, 250, 0).area;
    expect(localPatch(rounded, 250, 1e-9).area).toBeCloseTo(a0, 4);
    expect(localPatch(rounded, 250, -1e-9).area).toBeCloseTo(a0, 4);
  });

  it('area and volume grow monotonically as the tire is pressed down (safe to back-solve)', () => {
    let prev = localPatch(rounded, 260, Math.sin(0.02));
    for (let h = 259; h >= 230; h -= 1) {
      const cur = localPatch(rounded, h, Math.sin(0.02));
      expect(cur.area).toBeGreaterThanOrEqual(prev.area);
      expect(cur.volume).toBeGreaterThanOrEqual(prev.volume);
      prev = cur;
    }
  });

  it('rounded shoulders reduce the patch versus a sharp edge', () => {
    expect(localPatch(rounded, 250, 0).area).toBeLessThan(localPatch(sharp, 250, 0).area);
    expect(sliceRadius(rounded, 100)).toBeCloseTo(230, 9); // R − r_e at the edge
    expect(sliceRadius(rounded, 0)).toBe(260);
  });

  it('reports no contact above the ground and bottoming at the rim', () => {
    expect(localPatch(sharp, 261, 0).inContact).toBe(false);
    expect(localPatch(sharp, 160, 0).bottomedOut).toBe(true);
  });
});

describe('world contact patch', () => {
  const ground = { point: vec3(0, -100, 0), normal: vec3(0, 1, 0) };
  it('puts the centroid and outline on the ground plane, with camber-sense inclination', () => {
    const camber = 0.03; // top outboard → axle points slightly down
    const axis = vec3(Math.cos(camber), -Math.sin(camber), 0);
    const cp = contactPatch(vec3(600, 150, 0), axis, ground, rounded);
    expect(cp.inContact).toBe(true);
    expect(cp.inclination).toBeCloseTo(camber, 12);
    expect(dot(sub(cp.centroid!, ground.point), ground.normal)).toBeCloseTo(0, 8);
    for (const q of cp.outline) expect(q.y).toBeCloseTo(-100, 8);
    // Positive camber (top out) drops the outboard end of the axle, loading the OUTER tread edge:
    // centroid outboard of where the wheel center plane meets the ground (x = 600 − 250·tan γ).
    expect(cp.centroid!.x).toBeGreaterThan(600 - 250 * Math.tan(camber));
  });
});

describe('air volume', () => {
  it('is the annulus volume for a sharp-edged tire', () => {
    expect(airVolume(sharp)).toBeCloseTo(Math.PI * (260 ** 2 - 165 ** 2) * 200, 0);
    expect(airVolume(rounded)).toBeLessThan(airVolume(sharp));
  });
});

describe('tire force models', () => {
  const conditions = { setPressure: 83, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 };
  const gas = (over: Partial<Extract<TireForceModel, { kind: 'gas' }>> = {}): TireForceModel =>
    ({ kind: 'gas', conditions, volumeChange: false, volumeFactor: 1, ...over });

  it('ambient pressure follows the standard atmosphere', () => {
    expect(ambientPressure(0)).toBeCloseTo(101.325, 6);
    expect(ambientPressure(1500)).toBeCloseTo(84.56, 1);
  });

  it('gas model at constant volume: F = gauge pressure × area', () => {
    const lp = localPatch(rounded, 252, 0);
    expect(tireForce(gas(), rounded, lp).force).toBeCloseTo(83e-3 * lp.area, 9);
  });

  it('volume change raises pressure (toggle)', () => {
    const lp = localPatch(rounded, 245, 0);
    const off = tireForce(gas(), rounded, lp);
    const on = tireForce(gas({ volumeChange: true }), rounded, lp);
    expect(on.pressureGauge!).toBeGreaterThan(off.pressureGauge!);
    expect(on.volumeChangeRatio!).toBeLessThan(0);
  });

  it('back-solves the loaded height for a target load', () => {
    for (const model of [gas(), gas({ volumeChange: true }), { kind: 'stiffness', rate: 120 } as TireForceModel]) {
      const r = solveLoadedHeight(model, rounded, Math.sin(0.02), 900);
      expect(r.bottomedOut).toBe(false);
      expect(r.result.force).toBeCloseTo(900, 3);
    }
  });

  it('higher pressure or higher altitude means less deflection', () => {
    const base = solveLoadedHeight(gas(), rounded, 0, 900).centerHeight;
    const highP = solveLoadedHeight(gas({ conditions: { ...conditions, setPressure: 120 } }), rounded, 0, 900).centerHeight;
    const altitude = solveLoadedHeight(gas({ conditions: { ...conditions, operatingAltitude: 2000 } }), rounded, 0, 900).centerHeight;
    expect(highP).toBeGreaterThan(base);
    expect(altitude).toBeGreaterThan(base);
  });
});

describe('tire size parsing', () => {
  it('metric', () => {
    const t = parseTireSize('225/45R17')!;
    expect(t.format).toBe('metric');
    expect(t.outerDiameter).toBeCloseTo(634.3, 6);
    expect(t.sectionWidth).toBe(225);
    expect(parseTireSize('P205/55 R16')!.outerDiameter).toBeCloseTo(16 * 25.4 + 2 * 112.75, 6);
  });
  it('flotation and racing inch sizes', () => {
    const f = parseTireSize('31x10.50R15')!;
    expect(f.outerDiameter).toBeCloseTo(787.4, 6);
    expect(f.sectionWidth).toBeCloseTo(266.7, 6);
    expect(f.rimDiameter).toBeCloseTo(381, 6);
    expect(parseTireSize('20.5x7.0-13')!.outerDiameter).toBeCloseTo(520.7, 6);
  });
  it('rejects nonsense', () => {
    expect(parseTireSize('big tire')).toBeNull();
    expect(parseTireSize('13x20-15')).toBeNull(); // rim larger than OD
  });
});



describe('set pressure measured under load', () => {
  it('the unloaded set pressure, loaded again, reads the measured pressure (and is a little lower)', async () => {
    const { unloadedSetPressure, solveLoadedHeight, tireForce } = await import('../src/core');
    const profile = { radius: 260, width: 205, shoulderRadius: 25, rimRadius: 165 };
    const gas = { kind: 'gas' as const, volumeChange: true, volumeFactor: 1, conditions: { setPressure: 83, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 } };
    const p0 = unloadedSetPressure(gas, profile, 83, 800);
    expect(p0).toBeLessThan(83);
    expect(p0).toBeGreaterThan(70);
    const m = { ...gas, conditions: { ...gas.conditions, setPressure: p0 } };
    expect(tireForce(m, profile, solveLoadedHeight(m, profile, 0, 800).patch).pressureGauge!).toBeCloseTo(83, 3);
    expect(unloadedSetPressure({ kind: 'stiffness', rate: 120 }, profile, 83, 800)).toBe(83);
  });
});
