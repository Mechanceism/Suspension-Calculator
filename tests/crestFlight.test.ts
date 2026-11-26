import { describe, expect, it } from 'vitest';
import { rideRun, DEFAULT_MF, type VehicleProblem, type TireForceModel, type SegmentSpec } from '../src/core';
import { gradeAlong, heightAlong, vertCurvature, segmentStates } from '../src/core/tests/segments';
import { SAMPLE_LAYOUTS, SAMPLE_SPRING } from '../src/examples/sampleLayouts';
import { TEST_PRESETS, segmentSpec, transitionGrades, newSegment } from '../src/app/tests';
import { serializeProject, importProject, FORMAT_VERSION } from '../src/app/project';
import { defaultDesign } from '../src/app/store';

// Round 5 (item 8): the car isn't glued to the road — over a crest it can leave it and land through its tires and
// suspension; a transition segment rounds a change of grade.
const geom = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
const gas: TireForceModel = { kind: 'gas', volumeChange: true, volumeFactor: 1, conditions: { setPressure: 83, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 } };
const base = (): VehicleProblem => ({
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
const seg = (o: Partial<SegmentSpec>): SegmentSpec => ({ distance: 30, v0: 20, v1: 20, path: 'straight', radius: 0, grade: 0, bank: 0, ...o });
const offTime = (r: ReturnType<typeof rideRun>) => {
  const fr = r.frames, dt = fr[1]!.t - fr[0]!.t;
  return fr.filter((f) => Object.values(f.ride!.tireLoad).some((l) => l < 25)).length * dt;
};

describe('a transition: the grade changes evenly along it', () => {
  it('grade, height and curvature', () => {
    const t = seg({ distance: 20, grade: 0.1, gradeEnd: -0.1 });
    expect(gradeAlong(t, 0)).toBeCloseTo(0.1, 12);
    expect(gradeAlong(t, 10)).toBeCloseTo(0, 12);
    expect(gradeAlong(t, 20)).toBeCloseTo(-0.1, 12);
    expect(vertCurvature(t)).toBeCloseTo(-0.01, 12); // a crest of radius 100 m
    // Up and back down to the same height: symmetric.
    expect(heightAlong(t, 20)).toBeCloseTo(0, 9);
    expect(heightAlong(t, 10)).toBeCloseTo((1 - Math.cos(0.1)) / 0.01, 9);
    // One grade: a straight slope.
    expect(heightAlong(seg({ grade: 0.1 }), 10)).toBeCloseTo(10 * Math.sin(0.1), 12);
  });
  it('steady states: lighter over a crest by v²/R, heavier in a dip', () => {
    const flat = segmentStates(seg({}), 0)[0]!;
    const crest = segmentStates(seg({ distance: 40, grade: 0.1, gradeEnd: -0.1 }), 0)[0]!; // R 200 m at 20 m/s: −0.20 g
    const dip = segmentStates(seg({ distance: 40, grade: -0.1, gradeEnd: 0.1 }), 0)[0]!;
    expect(crest.gravityScale!).toBeCloseTo(flat.gravityScale! - (20 * 20) / 200 / 9.80665, 3);
    expect(dip.gravityScale!).toBeCloseTo(flat.gravityScale! + (20 * 20) / 200 / 9.80665, 3);
  });
  it('steady states where a sharp crest leaves the tires almost no load are skipped (judged over time)', () => {
    // 8 m from +8 % to −8 % at 80 km/h: about 1 g of lift — the car is practically weightless there.
    const sharp = seg({ distance: 8, v0: 80 / 3.6, v1: 80 / 3.6, grade: Math.atan(0.08), gradeEnd: Math.atan(-0.08) });
    expect(segmentStates(sharp, 0)).toEqual([]);
    // Slow over it: kept.
    expect(segmentStates({ ...sharp, v0: 5, v1: 5 }, 0).length).toBe(1);
  });
  it('in a test: from the segment before to the one after; saved (format 50)', () => {
    const t = { ...TEST_PRESETS.find((x) => x.label.startsWith('Hills'))!.make(), id: 'h' };
    const crest = t.segments.find((s) => s.name === 'Crest')!;
    expect(crest.transition).toBe(true);
    expect(transitionGrades(t, crest)).toEqual({ from: 10, to: -10 });
    const sp = segmentSpec(crest, t);
    expect(sp.grade).toBeCloseTo(Math.atan(0.1), 12);
    expect(sp.gradeEnd).toBeCloseTo(Math.atan(-0.1), 12);
    expect(FORMAT_VERSION).toBeGreaterThanOrEqual(50);
    const d = { ...defaultDesign(), tests: [t] };
    const back = importProject(JSON.parse(JSON.stringify(serializeProject(d as never, 'H')))).design;
    expect(back.tests[0]!.segments.find((s) => s.name === 'Crest')!.transition).toBe(true);
    expect(newSegment().transition).toBeUndefined();
  });
});

describe('the car leaves the road over a crest', () => {
  it('an abrupt crest launches it — wheels off about as long as a thrown body would be (2·u·sin Δγ / g) — and the landing loads the tires', () => {
    for (const u of [10, 20]) {
      const r = rideRun(base(), { FL: geom }, [seg({ v0: u, v1: u, grade: 0.1 }), seg({ distance: 40, v0: u, v1: u, grade: -0.1 })], { hz: 200 });
      const est = (2 * u * Math.sin(0.2)) / 9.80665;
      expect(offTime(r)).toBeGreaterThan(0.7 * est);
      expect(offTime(r)).toBeLessThan(1.4 * est);
      const peak = Math.max(...r.frames.map((f) => Math.max(...Object.values(f.ride!.tireLoad))));
      expect(peak).toBeGreaterThan(3 * 735); // ≈ 735 N per tire at rest
    }
  }, 120000);
  it('a transition rounds it: at 10 m/s over a 40 m crest (R 200 m, 0.05 g light) the wheels stay down', () => {
    const abrupt = rideRun(base(), { FL: geom }, [seg({ v0: 10, v1: 10, grade: 0.1 }), seg({ distance: 40, v0: 10, v1: 10, grade: -0.1 })], { hz: 200 });
    const round = rideRun(base(), { FL: geom }, [seg({ v0: 10, v1: 10, grade: 0.1 }), seg({ distance: 40, v0: 10, v1: 10, grade: 0.1, gradeEnd: -0.1 }), seg({ distance: 40, v0: 10, v1: 10, grade: -0.1 })], { hz: 200 });
    expect(offTime(abrupt)).toBeGreaterThan(0.2);
    expect(offTime(round)).toBe(0);
  }, 120000);
});

describe('landing checks (round 5)', () => {
  const jump = (over: Partial<ReturnType<typeof base>> = {}, checks?: Record<string, unknown>) => {
    const segs = [seg({ v0: 20, v1: 20, grade: 0.1 }), seg({ distance: 40, v0: 20, v1: 20, grade: -0.1 })].map((s) => (checks ? { ...s, checks: checks as never } : s));
    return rideRun({ ...base(), ...over }, { FL: geom }, segs, { hz: 200 }).findings.flat();
  };
  it('the body\'s landing g: a Warning by default (≈ 3 g), the rule\'s severity past its limit', async () => {
    const { PROFILES } = await import('../src/core/tests/checks');
    expect(jump().some((f) => f.check === 'impact' && f.severity === 'warn')).toBe(true);
    const strict = { ...PROFILES.default.checks, impact: { severity: 'fail', threshold: 2, threshold2: 1 } };
    expect(jump({}, strict).some((f) => f.check === 'impact' && f.severity === 'fail')).toBe(true);
  }, 60000);
  it('a tire\'s pressure over its sidewall maximum, its load over its rating', () => {
    const d = base().designs.FL!;
    const rated = { ...d, model: { ...d.model, maxPressure: 60, ratedLoad: 1000 } as typeof d.model };
    const fs = jump({ designs: { FL: rated } });
    expect(fs.some((f) => f.check === 'blowout' && f.severity === 'fail' && /sidewall maximum/.test(f.text))).toBe(true);
    expect(fs.some((f) => f.check === 'tireOverload' && f.severity === 'fail' && /rated load/.test(f.text))).toBe(true);
    // Not given: the cold pressure and an estimated rating — this jump stays within them.
    expect(jump().filter((f) => f.check === 'blowout' || f.check === 'tireOverload')).toEqual([]);
  }, 60000);
});

describe('tire sidewall ratings (format 51)', () => {
  it('max pressure and load rating: saved, opened, into the tire model (0 = not given)', async () => {
    const { toForceModel } = await import('../src/app/store');
    const d = defaultDesign();
    expect(FORMAT_VERSION).toBeGreaterThanOrEqual(51);
    expect(d.tire.maxPressure.value).toBe(0);
    expect(d.tire.loadRating.value).toBe(0);
    const m0 = toForceModel('gas', d.tire, true) as { maxPressure?: number; ratedLoad?: number };
    expect(m0.maxPressure).toBeUndefined();
    expect(m0.ratedLoad).toBeUndefined();
    const rated = { ...d, tire: { ...d.tire, maxPressure: { text: '240', value: 240 }, loadRating: { text: '450', value: 450 } } };
    const back = importProject(JSON.parse(JSON.stringify(serializeProject(rated as never, 'T')))).design;
    expect(back.tire.maxPressure.value).toBe(240);
    const m = toForceModel('gas', back.tire, true) as { maxPressure?: number; ratedLoad?: number };
    expect(m.maxPressure).toBe(240);
    expect(m.ratedLoad).toBeCloseTo(450 * 9.80665, 6);
  });
});

describe('the driver at a crest, by the pass rules (round 5)', () => {
  it('keeping 3 wheels down: the plan caps a crest at √(0.7·g / |κ|); free (fewer wheels / Pass) it doesn\'t', async () => {
    const { planSpeeds, crestSpeed } = await import('../src/core/tests/plan');
    const car = { muFront: 1.2, muRear: 1.2, frontShare: 0.5, cgHeight: 400, wheelbase: 2500, track: 1500, brakeBias: 0.6, driveSplit: 0, brakesFront: true, brakesRear: true, drivenFront: false, drivenRear: true, mass: 1000 };
    // A 20 m crest from +8 % to −8 % (κ ≈ −0.008 /m): ≈ 82 km/h keeps 30 % of the load.
    const segs = [seg({ v0: 30, v1: 30, distance: 60, grade: Math.atan(0.08) }), seg({ v0: 30, v1: 30, distance: 20, grade: Math.atan(0.08), gradeEnd: Math.atan(-0.08) }), seg({ v0: 30, v1: 30, distance: 60, grade: Math.atan(-0.08) })];
    const free = planSpeeds(segs, car, [0.95, 0.95, 0.95]);
    const down = planSpeeds(segs, car, [0.95, 0.95, 0.95], [], { wheelsDown: [true, true, true] });
    const k = (Math.atan(-0.08) - Math.atan(0.08)) / 20;
    expect(Math.max(...free.plans[1]!.v)).toBeCloseTo(30, 6);
    expect(Math.max(...down.plans[1]!.v)).toBeLessThanOrEqual(crestSpeed(k) + 1e-6);
    expect(crestSpeed(k)).toBeCloseTo(Math.sqrt((0.7 * 9.80665) / -k), 9);
    // An abrupt crest (no transition): the drop spread over the wheelbase.
    const abrupt = planSpeeds([segs[0]!, segs[2]!], car, [0.95, 0.95], [], { wheelsDown: [true, true] });
    const atCrest = abrupt.plans[1]!.v[0]!;
    expect(atCrest).toBeCloseTo(crestSpeed((Math.atan(-0.08) - Math.atan(0.08)) / 2.5, Math.atan(-0.08)), 3);
  });
  it('wheels on the ground over time: a jump fails the Default rule (at least 3), not Off-road (Pass)', async () => {
    const { PROFILES } = await import('../src/core/tests/checks');
    const fly = (checks: unknown) => rideRun(base(), { FL: geom }, [seg({ v0: 20, v1: 20, grade: 0.1 }), seg({ distance: 40, v0: 20, v1: 20, grade: -0.1 })].map((s) => ({ ...s, checks: checks as never })), { hz: 200 }).findings.flat();
    expect(fly(PROFILES.default.checks).some((f) => f.check === 'airborne' && f.severity === 'fail')).toBe(true);
    expect(fly(PROFILES.offroad.checks).some((f) => f.check === 'airborne')).toBe(false);
  }, 60000);
});
