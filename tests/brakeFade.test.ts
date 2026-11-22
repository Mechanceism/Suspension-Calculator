import { describe, it, expect } from 'vitest';
import { rotorStep, padFactor, coolingAt, ROTOR_SPECIFIC_HEAT, type BrakeThermal, DEFAULT_MF } from '../src/core';
import { runTest, playbackFrames } from '../src/core/tests/run';
import { SAMPLE_LAYOUTS, SAMPLE_SPRING } from '../src/examples/sampleLayouts';

const C = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
const th = (o: Partial<BrakeThermal> = {}): BrakeThermal => ({
  rotorMass: { front: 2.5, rear: 2 }, cooling: 25, fadeStart: 400, fadeEnd: 650, fadeLoss: 0.4, air: 20, start: 50, ...o,
});

function car(extra: object = {}) {
  const gas = { kind: 'gas' as const, volumeChange: true, volumeFactor: 1, conditions: { setPressure: 83, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 } };
  return {
    designs: { FL: { geometry: C, profile: { radius: 260, width: 205, shoulderRadius: 25, rimRadius: 165 }, model: gas, springRate: SAMPLE_SPRING.rate, freeLength: SAMPLE_SPRING.freeLength, unsprungMass: 12 } },
    roots: { FL: 'FL', FR: 'FL', RL: 'FL', RR: 'FL' } as const,
    settings: { FL: { brake: 'outboard', drive: 'none' }, FR: { brake: 'outboard', drive: 'none' }, RL: { brake: 'outboard', drive: 'chassis' }, RR: { brake: 'outboard', drive: 'chassis' } } as const,
    mass: 300, cg: { x: 0, height: 280, z: -0.47 * 1550 }, wheelbase: 1550, brakeBias: 0.6, driveSplit: 0.5, autoPreload: true,
    shared: { front: { antiRollBar: { kind: 'none' as const }, heaveSpring: { kind: 'none' as const } }, rear: { antiRollBar: { kind: 'none' as const }, heaveSpring: { kind: 'none' as const } } },
    dropLinks: { front: null, rear: null }, droop: 40, bump: 40, cases: { lateralG: 0, brakingG: 0, accelG: 0 }, goals: [], variables: [],
    steering: { steered: { FL: true, FR: true }, rackLimit: 30, cFactor: 75 }, tireGrip: DEFAULT_MF,
    // Strong enough cold for 0.8 g (front 0.6 · 300 kg · 0.8 g ≈ 1410 N), not once the pads lose half their grip.
    brakeLimit: { front: 2000, rear: 1400, maxPedal: 500 },
    ...extra,
  };
}
const stop = (v0: number, v1: number, distance: number) => ({ name: 'stop', distance, v0, v1, path: 'straight' as const, radius: 0, grade: 0, bank: 0 });
const cruise = (v: number, distance: number) => ({ name: 'cruise', distance, v0: v, v1: v, path: 'straight' as const, radius: 0, grade: 0, bank: 0 });

describe('brake thermal model', () => {
  it('heats toward air + P / hA and cools back with the time constant C / hA; pads fade linearly', () => {
    const t = th();
    const hA = coolingAt(t, 10), Cth = 2.5 * ROTOR_SPECIFIC_HEAT;
    expect(rotorStep(t, 2.5, 20, 1000, 10, 1e6)).toBeCloseTo(20 + 1000 / hA, 6);
    expect(rotorStep(t, 2.5, 300, 0, 10, Cth / hA)).toBeCloseTo(20 + 280 / Math.E, 6);
    expect(coolingAt(t, 100 / 3.6)).toBeCloseTo(25, 9);
    expect(coolingAt(t, 0)).toBeCloseTo(5, 9);
    expect(padFactor(t, 300)).toBe(1);
    expect(padFactor(t, 525)).toBeCloseTo(0.8, 9);
    expect(padFactor(t, 900)).toBeCloseTo(0.6, 9);
  });
});

describe('brake fade in a test', () => {
  it('a stop heats each rotor by about its share of the kinetic energy', () => {
    const p = car({ brakeThermal: th({ cooling: 1e-6 }) });
    const run = runTest(p as never, { FL: C }, [stop(25, 0, 50)], { onFail: 'report' });
    const s = run.segments[0]!;
    expect(s.brakeTemp).toBeDefined();
    // ½ m v² split by the brake bias, two rotors per axle.
    const ke = 0.5 * 300 * 25 * 25;
    expect(s.brakeTemp!.end.front - 50).toBeCloseTo((0.6 * ke) / 2 / (2.5 * ROTOR_SPECIFIC_HEAT), -1);
    expect(s.brakeTemp!.end.rear - 50).toBeCloseTo((0.4 * ke) / 2 / (2 * ROTOR_SPECIFIC_HEAT), -1);
    expect(run.passed).toBe(true);
  });

  it('repeated hard stops fade the brakes until they are too weak; without fade it passes', () => {
    const segs = [];
    for (let i = 0; i < 6; i++) segs.push(stop(30, 10, 51), cruise(10, 30), { ...stop(10, 30, 150), name: 'go' });
    // Light rotors on pads that fade early.
    const hot = car({ brakeThermal: th({ rotorMass: { front: 1.2, rear: 1.2 }, fadeStart: 120, fadeEnd: 220, fadeLoss: 0.6, cooling: 8 }) });
    const run = runTest(hot as never, { FL: C }, segs, { onFail: 'report' });
    const temps = run.segments.filter((_, i) => i % 3 === 0).map((s) => s.brakeTemp!.end.front);
    expect(temps.at(-1)!).toBeGreaterThan(temps[0]!); // heat builds up stop to stop
    const findings = run.segments.flatMap((s) => s.findings);
    expect(findings.some((f) => f.check === 'brakeFade')).toBe(true);
    expect(findings.some((f) => f.check === 'brakeLimit' && f.text.startsWith('Brake fade'))).toBe(true);
    expect(run.passed).toBe(false);
    expect(run.segments[0]!.passed).toBe(true); // the first stop is still cold enough (+65 °C)
    const cold = runTest(car() as never, { FL: C }, segs, { onFail: 'report' });
    expect(cold.passed).toBe(true);
    // Playback carries the temperatures too.
    const frames = playbackFrames(hot as never, { FL: C }, segs.slice(0, 3), 5);
    expect(frames.every((f) => f.brakeTemp)).toBe(true);
    expect(frames.at(-1)!.brakeTemp!.front).toBeGreaterThan(frames[0]!.brakeTemp!.front);
  });
});

describe('brake fade in the app', () => {
  it('is saved with the project; older files load with it off', async () => {
    const { defaultDesign } = await import('../src/app/store');
    const { serializeProject, importProject } = await import('../src/app/project');
    const d = defaultDesign();
    d.brakes = { ...d.brakes, on: true, fade: true, rotorMassF: { text: '4.2', value: 4.2 } };
    const json = JSON.parse(JSON.stringify(serializeProject(d, 'F')));
    const back = importProject(json).design;
    expect(back.brakes.fade).toBe(true);
    expect(back.brakes.rotorMassF.value).toBeCloseTo(4.2, 9);
    const old = JSON.parse(JSON.stringify(serializeProject(defaultDesign(), 'Old')));
    old.formatVersion = 24;
    delete old.brakes.fade;
    const o = importProject(old);
    expect(o.design.brakes.fade).toBe(false);
    expect(o.warnings.filter((w: string) => !w.startsWith('Upgraded'))).toEqual([]);
  });
});
