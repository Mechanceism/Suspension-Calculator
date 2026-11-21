import { describe, it, expect } from 'vitest';
import {
  roughHeight, featureHeight, worstRoadSpots, wheelHeights, segmentStates, playbackFrames,
  type RoughSurface, type SegmentSpec, type VehicleProblem, type TireForceModel,
} from '../src/core';
import { SAMPLE_LAYOUTS, SAMPLE_SPRING } from '../src/examples/sampleLayouts';

const rough: RoughSurface = { seed: 7, maxHeight: 40, scale: 1.5, coverage: 1 };

describe('road surface', () => {
  it('is repeatable per seed, bounded by the max height, flat with no coverage', () => {
    const pts = Array.from({ length: 400 }, (_, i) => [i * 0.13, ((i * 7) % 30) / 10 - 1.5] as const);
    const a = pts.map(([s, y]) => roughHeight(rough, s, y));
    expect(pts.map(([s, y]) => roughHeight(rough, s, y))).toEqual(a);
    expect(pts.map(([s, y]) => roughHeight({ ...rough, seed: 8 }, s, y))).not.toEqual(a);
    expect(Math.max(...a.map(Math.abs))).toBeLessThanOrEqual(40 + 1e-9);
    expect(Math.max(...a.map(Math.abs))).toBeGreaterThan(15);
    expect(pts.every(([s, y]) => roughHeight({ ...rough, coverage: 0 }, s, y) === 0)).toBe(true);
    // Smaller scale = more bumps (more sign changes along a line).
    const changes = (sc: number) => { let n = 0, prev = 0; for (let s = 0; s < 40; s += 0.05) { const h = roughHeight({ ...rough, scale: sc }, s, 0); if (prev && Math.sign(h) !== Math.sign(prev)) n++; prev = h; } return n; };
    expect(changes(0.5)).toBeGreaterThan(changes(3));
  });

  it('places bumps and potholes under the chosen track, peaking mid-length', () => {
    const fs = [{ kind: 'bump' as const, at: 10, length: 2, height: 50, side: 'left' as const }, { kind: 'pothole' as const, at: 20, length: 1, height: 40, side: 'both' as const }];
    expect(featureHeight(fs, 11, 0.7)).toBeCloseTo(50, 9);
    expect(featureHeight(fs, 11, -0.7)).toBe(0);
    expect(featureHeight(fs, 20.5, -0.7)).toBeCloseTo(-40, 9);
    const h = wheelHeights({ features: fs }, 11, 1.55, 0.6);
    expect(h.FL).toBeCloseTo(50, 9);
    expect(h.FR).toBe(0);
    // The worst spots include the bump peak under a wheel.
    const spots = worstRoadSpots({ features: fs }, 30, 1.55, 0.6);
    expect(spots.some((s) => Math.abs(s - 11) < 0.15 || Math.abs(s - 12.55) < 0.15)).toBe(true);
  });

  it('segments add steady states at the worst road spots', () => {
    const seg: SegmentSpec = { distance: 30, v0: 15, v1: 15, path: 'straight', radius: 0, grade: 0, bank: 0, road: { features: [{ kind: 'pothole', at: 10, length: 1, height: 40, side: 'right' }] } };
    const st = segmentStates(seg, 0, 1, { wheelbase: 1550, halfTrack: 600 });
    expect(st.length).toBeGreaterThan(1);
    expect(st.some((x) => (x.groundOffset.FR ?? 0) < -30 || (x.groundOffset.RR ?? 0) < -30)).toBe(true);
  });
});

describe('playback', () => {
  it('drives the chain at constant acceleration per segment; a quarter turn turns the heading 90°', () => {
    const geom = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
    const profile = { radius: 260, width: 205, shoulderRadius: 25, rimRadius: 165 };
    const gas: TireForceModel = { kind: 'gas', volumeChange: true, volumeFactor: 1, conditions: { setPressure: 83, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 } };
    const des = { geometry: geom, profile, model: gas, springRate: SAMPLE_SPRING.rate, freeLength: SAMPLE_SPRING.freeLength, unsprungMass: 12 };
    const p: VehicleProblem = {
      designs: { FL: des }, roots: { FL: 'FL', FR: 'FL', RL: 'FL', RR: 'FL' },
      settings: { FL: { brake: 'outboard', drive: 'none' }, FR: { brake: 'outboard', drive: 'none' }, RL: { brake: 'outboard', drive: 'chassis' }, RR: { brake: 'outboard', drive: 'chassis' } },
      mass: 300, cg: { x: 0, height: 280, z: -0.47 * 1550 }, wheelbase: 1550, brakeBias: 0.6, driveSplit: 0.5, autoPreload: true,
      shared: { front: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } }, rear: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } } },
      dropLinks: { front: null, rear: null }, droop: 50, bump: 50, cases: { lateralG: 0, brakingG: 0, accelG: 0 }, goals: [], variables: [],
    };
    const R = 20;
    const segs: SegmentSpec[] = [
      { distance: 20, v0: 0, v1: 10, path: 'straight', radius: 0, grade: 0, bank: 0 },
      { distance: (Math.PI * R) / 2, v0: 10, v1: 10, path: 'left', radius: R, grade: 0, bank: 0 },
    ];
    const frames = playbackFrames(p, { FL: geom }, segs, 10);
    // 20 m at 5 m/s average = 4 s, then 31.4 m at 10 m/s = 3.14 s → about 71 frames.
    expect(frames.length).toBeGreaterThan(65);
    expect(frames.length).toBeLessThan(76);
    const last = frames[frames.length - 1]!;
    expect(last.heading).toBeGreaterThan(Math.PI / 2 * 0.9);
    expect(last.heading).toBeLessThan(Math.PI / 2 * 1.02);
    expect(frames[0]!.ax).toBeCloseTo(10 / 4 / 9.80665, 6);
    expect(frames.every((f) => f.severity !== undefined)).toBe(true);
  });
});
