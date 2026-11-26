import { describe, expect, it } from 'vitest';
import { runTest } from '../src/core';
import { vehicleInputOf, assembleVehicle, type VehicleProblem } from '../src/core/optimize/vehicle';
import { forceSetup, tireForcesFor, overlapNet, type CornerId, type TireCaps } from '../src/core/vehicle/vehicle';
import { defaultDesign, type AppState } from '../src/app/store';
import { buildVehicleProblem } from '../src/app/optimizer';
import { TEST_PRESETS, segmentSpec, planOption, driverSpeedOf, styleOf, newSegment, type TestDesign } from '../src/app/tests';
import { serializeProject, importProject } from '../src/app/project';

// Round 5: driving and braking at once, by the driving style; brake-based traction control.
const problem = (tc = false) => {
  const d = defaultDesign();
  return buildVehicleProblem({ ...d, brakes: { ...d.brakes, tc } } as unknown as AppState).problem;
};
const geoms = (p: VehicleProblem) => Object.fromEntries(Object.entries(p.designs).map(([r, x]) => [r, x!.geometry]));
const IDS: CornerId[] = ['FL', 'FR', 'RL', 'RR'];
const fx = (f: ReturnType<typeof tireForcesFor>) => Object.fromEntries(IDS.map((id) => [id, f[id].brake + f[id].drive])) as Record<CornerId, number>;
const sum = (r: Record<CornerId, number>) => IDS.reduce((a, id) => a + r[id], 0);
const caps = (x: Partial<Record<CornerId, number>> = {}): Record<CornerId, TireCaps> =>
  Object.fromEntries(IDS.map((id) => [id, { x: x[id] ?? 4000, y: 4000 }])) as unknown as Record<CornerId, TireCaps>;
const drive = (t: Omit<TestDesign, 'id'>, style?: TestDesign['style']): TestDesign => ({ ...t, id: 't', ...(style ? { style } : {}) });
const runIt = (p: VehicleProblem, t: TestDesign) =>
  runTest(p, geoms(p) as never, t.segments.map((s) => segmentSpec(s, t)), { onFail: 'report', speedLimits: true, ride: true, handling: true, driverSpeed: driverSpeedOf(t), ...planOption(t) });

describe('both pedals at once in the vehicle model', () => {
  const p = problem();
  const asm = assembleVehicle(p, geoms(p) as never)!;
  const loads = { FL: 3500, FR: 3500, RL: 3500, RR: 3500 };
  const at = (o: Parameters<typeof vehicleInputOf>[2], overlap?: Parameters<typeof overlapNet>[0]) => {
    const input = { ...vehicleInputOf(p, asm, o), ...(overlap ? { overlap } : {}) };
    return fx(tireForcesFor(input, forceSetup(input), loads, caps()));
  };

  it('left-foot braking: the same net push, the driven wheels brake less, the others more', () => {
    // The default car drives its rear wheels; braking at 0.6 g with 1500 N of throttle kept on.
    const plain = at({ lateralG: 0, brakingG: 0.6, accelG: 0 });
    const lfb = at({ lateralG: 0, brakingG: 0.6, accelG: 0 }, { drive: 1500, pedalBrake: 1500 });
    expect(sum(lfb)).toBeCloseTo(sum(plain), 6);
    expect(lfb.RL).toBeGreaterThan(plain.RL + 100); // driven: less braking
    expect(lfb.FL).toBeLessThan(plain.FL - 100); // not driven: more
  });

  it('a handbrake: the rear wheels braked as given, the drive cut from them; the net push includes it', () => {
    const o = { brake: { RL: 3000, RR: 3000 }, cut: ['RL', 'RR'] as CornerId[] };
    expect(overlapNet(o)).toBe(-6000);
    const m = p.mass, G = 9.80665;
    // The car slows by the handbrake alone (no pedal): its braking g is the handbrake's.
    const hb = at({ lateralG: 0, brakingG: 6000 / (m * G), accelG: 0 }, o);
    expect(hb.RL).toBeCloseTo(-3000, 6);
    expect(hb.RR).toBeCloseTo(-3000, 6);
    expect(hb.FL).toBeCloseTo(0, 6);
  });
});

describe('brake-based traction control (open differential)', () => {
  const p = problem(true);
  const asm = assembleVehicle(p, geoms(p) as never)!;
  const loads = { FL: 3500, FR: 3500, RL: 2000, RR: 5000 };
  const rearFx = (tc: boolean, accelG: number, light: number) => {
    const input = { ...vehicleInputOf(p, asm, { lateralG: 0, brakingG: 0, accelG }), ...(tc ? {} : { brakeTC: false }) };
    const f = fx(tireForcesFor(input, forceSetup(input), loads, caps({ RL: light, RR: 6000 })));
    return [f.RL, f.RR];
  };
  it('equal drive while both grip; past the lighter wheel\'s grip it is held there and the other takes the rest', () => {
    const [l0, r0] = rearFx(true, 0.1, 1500);
    expect(l0).toBeCloseTo(r0, 6); // within grip: as an open differential
    const [l1, r1] = rearFx(true, 0.4, 300);
    expect(l1).toBeCloseTo(300, 6);
    expect(r1).toBeGreaterThan(l1 + 300);
    const [a, b] = rearFx(true, 0.4, 6000);
    expect(l1 + r1).toBeCloseTo(a + b, 6); // the whole drive still delivered
    const [l2, r2] = rearFx(false, 0.4, 300);
    expect(l2).toBeCloseTo(r2, 6); // without: still equal (the light wheel spins: the ride's limit is 2 × its grip)
  });
});

describe('the driving style in the ride', () => {
  it('Auto by the pass rules; saved with the test and the car (format 53)', () => {
    const t = drive(TEST_PRESETS[0]!.make());
    expect(styleOf(t)).toBeUndefined();
    expect(styleOf({ ...t, profile: 'drift' })).toBe('drift');
    expect(styleOf({ ...t, profile: 'offroad' })).toBe('rally');
    expect(styleOf({ ...t, profile: 'drag' })).toBe('drag');
    expect(styleOf({ ...t, profile: 'drift', style: 'none' })).toBeUndefined();
    expect(styleOf({ ...t, style: 'rally' })).toBe('rally');
    const d = defaultDesign();
    const s0 = { ...d, brakes: { ...d.brakes, tc: true }, tests: [{ ...t, style: 'drift' as const }] };
    const file = JSON.parse(JSON.stringify(serializeProject(s0 as never, 'S')));
    expect(file.formatVersion).toBe(53);
    const back = importProject(file).design;
    expect(back.brakes.tc).toBe(true);
    expect(back.tests[0]!.style).toBe('drift');
  });

  it('drag: the line-lock before the launch — noted, not timed, its spinning rears not a finding', () => {
    const p = problem();
    const t = drive(TEST_PRESETS.find((x) => x.label.startsWith('Drag strip'))!.make());
    expect(styleOf(t)).toBe('drag');
    const ll = runIt(p, t), none = runIt(p, { ...t, style: 'none' });
    expect(ll.segments[0]!.technique).toMatch(/line-lock burnout before the launch \(1\.5 s/);
    expect(none.segments[0]!.technique).toBeUndefined();
    expect(Math.abs(ll.time! - none.time!)).toBeLessThan(0.05);
    expect(ll.segments.flatMap((s) => s.findings).filter((f) => f.check === 'wheelspin')).toEqual([]);
  }, 120000);

  it('drift: the handbrake into a turn starts a slide (more sideslip); rally: left-foot braking into it', () => {
    const p = problem();
    const MPH = 0.44704;
    const t0 = drive({
      ...TEST_PRESETS[0]!.make(),
      segments: [
        newSegment({ name: 'In', distance: { text: '40', value: 40 }, speedStart: { text: '', value: 35 * MPH }, speedEnd: { text: '', value: 25 * MPH } }),
        newSegment({ name: 'Turn', path: 'left', radius: { text: '20', value: 20 }, distance: { text: '30', value: 30 }, speedStart: { text: '', value: 25 * MPH }, speedEnd: { text: '', value: 25 * MPH } }),
      ],
    });
    const none = runIt(p, { ...t0, style: 'none' });
    const drift = runIt(p, { ...t0, style: 'drift' });
    const rally = runIt(p, { ...t0, style: 'rally' });
    expect(drift.segments.map((s) => s.technique).join(' ')).toMatch(/handbrake into the turn \(0\.\d s, the rear wheels braked to their grip, clutch in\)/);
    expect(drift.ride!.metrics!.maxSideslip!).toBeGreaterThan(none.ride!.metrics!.maxSideslip! + 1);
    expect(rally.segments.map((s) => s.technique).join(' ')).toMatch(/left-foot braking into the turns/);
    expect(none.segments.every((s) => !s.technique)).toBe(true);
  }, 240000);
});
