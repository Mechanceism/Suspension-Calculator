import { describe, it, expect, beforeEach } from 'vitest';
import {
  brakeCapacity, wheelTorque, maxRotor, fitsWheel, brakeFixes, pedalFixes, pedalTravel, circuitVolume, brakeLadder, pickStep,
  padFactors, CALIPER_STEPS, type BrakeSystem, type BrakeAxle, type BrakeDetail,
} from '../src/core';
import { useApp, defaultDesign, type AppState } from '../src/app/store';
import { serializeProject, importProject, FORMAT_VERSION } from '../src/app/project';
import { brakesOf, buildVehicleProblem } from '../src/app/optimizer';
import { sizeBrakes, hardestUse } from '../src/app/brakeLadder';
import { runTest } from '../src/core/tests/run';

const A = (d: number) => (Math.PI / 4) * d * d;
const disc: BrakeAxle = { kind: 'disc', mcBore: 19.05, pistonDiameter: 32, pistonsPerSide: 2, padMu: 0.45, rotorRadius: 100 };
const drum: BrakeAxle = { kind: 'drum', mcBore: 19.05, pistonDiameter: 0, pistonsPerSide: 0, padMu: 0.4, rotorRadius: 0, wheelCylinder: 19.05, drumRadius: 114.3, brakeFactor: 2.2, fadeSensitivity: 1.8 };
const sys: BrakeSystem = { maxPedalForce: 400, pedalRatio: 4, boost: 1, dualMc: false, balanceFront: 0.5, front: disc, rear: drum };
const detail: BrakeDetail = { mcStroke: 32, maxPedalTravel: 100, padClearance: 0.15, shoeClearance: 0.4, compliance: { front: 150, rear: 120 } };
const room = { rimDiameter: 330.2, clearance: 38, padHeight: 36 }; // 13" rim

describe('brakes: drums, fitting the wheel, what would fix it', () => {
  it('a drum: torque = brake factor × wheel-cylinder force × drum radius; a disc is unchanged', () => {
    expect(wheelTorque(drum, 5)).toBeCloseTo(2.2 * 5 * A(19.05) * 114.3, 6);
    expect(wheelTorque(disc, 5)).toBeCloseTo(2 * 0.45 * 5 * 2 * A(32) * 100, 6);
    const c = brakeCapacity(sys, { front: 260, rear: 260 });
    const p = (400 * 4) / A(19.05);
    expect(c.torque.rear).toBeCloseTo(wheelTorque(drum, p) / 1000, 6);
    // A drum's capacity falls faster than its lining when hot (BF ∝ μ^k).
    const th = { rotorMass: { front: 3, rear: 3 }, cooling: 25, fadeStart: 300, fadeEnd: 500, fadeLoss: 0.4, air: 20, start: 50, sensitivity: { front: 1, rear: 1.8 } };
    const f = padFactors(th, { front: 500, rear: 500 });
    expect(f.front).toBeCloseTo(0.6, 9);
    expect(f.rear).toBeCloseTo(0.6 ** 1.8, 9);
  });

  it('the largest rotor / drum that fits the rim; fixes that each multiply the torque by k', () => {
    const m = maxRotor(room);
    expect(m.diameter).toBeCloseTo(330.2 - 76, 6);
    expect(m.effectiveRadius).toBeCloseTo((330.2 - 76) / 2 - 18, 6);
    expect(fitsWheel(disc, room)).toBe(true);
    expect(fitsWheel({ ...disc, rotorRadius: 120 }, room)).toBe(false);
    const k = 1.3;
    const fixes = brakeFixes(disc, k, room);
    const t0 = wheelTorque(disc, 1);
    const apply = (what: string, patch: (v: number) => Partial<BrakeAxle>) => { const fx = fixes.find((x) => x.what.startsWith(what))!; return { fx, t: wheelTorque({ ...disc, ...patch(fx.needed) }, 1) / t0 }; };
    expect(apply('Effective rotor', (v) => ({ rotorRadius: v })).t).toBeCloseTo(k, 9);
    expect(apply('Effective rotor', (v) => ({ rotorRadius: v })).fx.fits).toBe(false); // 130 mm doesn't fit a 13" wheel
    expect(apply('Caliper piston', (v) => ({ pistonDiameter: v })).t).toBeCloseTo(k, 9);
    expect(apply('Pistons per side', (v) => ({ pistonsPerSide: v })).fx.needed).toBe(3);
    // A smaller master cylinder raises the pressure by its area.
    const mc = fixes.find((x) => x.what.startsWith('Master'))!;
    expect(A(disc.mcBore) / A(mc.needed)).toBeCloseTo(k, 9);
    expect(pedalFixes(sys, k).find((x) => x.what === 'Pedal ratio')!.needed).toBeCloseTo(5.2, 9);
    expect(brakeFixes(disc, 0.9)).toEqual([]);
  });

  it('detailed hydraulics: fluid → master-cylinder travel → pedal travel (hand check)', () => {
    const t = pedalTravel(sys, detail, 1);
    const p = (400 * 4) / A(19.05);
    const vf = 2 * (2 * A(32) * 2 * 0.15) + 150 * p;
    const vr = 2 * (2 * A(19.05) * 0.4) + 120 * p;
    expect(circuitVolume(disc, detail, 150, p)).toBeCloseTo(vf, 6);
    expect(t.mc.front).toBeCloseTo(vf / A(19.05), 6);
    expect(t.mc.rear).toBeCloseTo(vr / A(19.05), 6);
    // Tandem: both chambers in series on one stroke; the pedal moves the ratio × the pushrod.
    expect(t.pedal).toBeCloseTo(4 * (vf + vr) / A(19.05), 6);
    expect(t.strokeUse).toBeCloseTo((vf + vr) / A(19.05) / 32, 6);
    // Half the pedal force: the clearances still close, the swell halves.
    expect(pedalTravel(sys, detail, 0.5).pedal).toBeLessThan(t.pedal);
    expect(pedalTravel(sys, detail, 0.5).pedal).toBeGreaterThan(t.pedal / 2);
    // Balance bar: the pushrod sits at the bar's pivot.
    const d = pedalTravel({ ...sys, dualMc: true, balanceFront: 0.6 }, detail, 1);
    expect(d.pedal).toBeCloseTo(4 * (0.6 * d.mc.front + 0.4 * d.mc.rear), 6);
  });

  it('the ladder: more pistons first, larger rotors last, only what fits; the smallest step that is enough', () => {
    const lad = brakeLadder('disc', room);
    expect(lad.length % CALIPER_STEPS.length).toBe(0);
    // Every caliper on the smallest rotor before the next rotor; nothing larger than fits.
    expect(lad[0]!.patch.rotorRadius).toBe(lad[CALIPER_STEPS.length - 1]!.patch.rotorRadius);
    expect(lad[CALIPER_STEPS.length]!.patch.rotorRadius!).toBeGreaterThan(lad[0]!.patch.rotorRadius!);
    expect(Math.max(...lad.map((s) => s.patch.rotorRadius!))).toBeLessThanOrEqual(maxRotor(room).effectiveRadius + 1e-9);
    // Within one rotor the torque rises step by step.
    const t = lad.slice(0, CALIPER_STEPS.length).map((s) => wheelTorque({ ...disc, ...s.patch }, 1));
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThan(t[i - 1]!);
    const up = pickStep(disc, lad, 1.4);
    expect(wheelTorque({ ...disc, ...up.step!.patch }, 1) / wheelTorque(disc, 1)).toBeGreaterThanOrEqual(1.4);
    // Stepping down when there is a lot to spare.
    expect(pickStep(disc, lad, 0.5).gain).toBeLessThan(1);
    // Too much for the wheel: short, by how much.
    const no = pickStep(disc, lad, 20);
    expect(no.step).toBeNull();
    expect(no.short!).toBeGreaterThan(1);
    // Drums: wheel cylinders first, then larger drums that fit.
    const dl = brakeLadder('drum', room);
    expect(dl[0]!.patch.drumRadius).toBe(dl[1]!.patch.drumRadius);
    expect(Math.max(...dl.map((s) => s.patch.drumRadius!))).toBeLessThanOrEqual(maxRotor(room).drumRadius);
  });
});

describe('brakes in the app: sizing to the tests', () => {
  beforeEach(() => {
    const d = defaultDesign();
    d.brakes = { ...d.brakes, on: true };
    useApp.setState({ ...d });
  });
  const st = () => useApp.getState() as AppState;

  it('too weak: steps up to keep the reserve; lots to spare: steps down', () => {
    const m0 = brakesOf(st())!;
    const z = sizeBrakes(st(), { front: 1.3, rear: 0.5 })!;
    expect(z.changes.length).toBeGreaterThan(0);
    useApp.getState().setBrakes(z.patch);
    const m1 = brakesOf(st())!;
    const reserve = st().brakes.ladderReserve.value / 100;
    expect(m1.capacity.axleForce.front / m0.capacity.axleForce.front).toBeGreaterThanOrEqual(1.3 * (1 + reserve) - 1e-6);
    // The rear had plenty to spare but is already smaller than any step on the ladder: kept.
    expect(m1.capacity.axleForce.rear).toBeCloseTo(m0.capacity.axleForce.rear, 6);
    // Lots to spare at the front now: a smaller step, still with the reserve.
    const z2 = sizeBrakes(st(), { front: 0.3, rear: 0.5 })!;
    useApp.getState().setBrakes(z2.patch);
    const m2 = brakesOf(st())!;
    expect(m2.capacity.axleForce.front).toBeLessThan(m1.capacity.axleForce.front);
    expect(m2.capacity.axleForce.front / m1.capacity.axleForce.front).toBeGreaterThanOrEqual(0.3 * (1 + reserve) - 1e-6);
  });

  it('drums: stay drums unless discs are allowed; then switch; the bias holds with a balance bar', () => {
    useApp.getState().setBrakes({ drumR: true });
    const z = sizeBrakes(st(), { front: 0.8, rear: 50 })!;
    expect(z.askDisc).toEqual(['rear']);
    expect(z.patch.drumR).toBeUndefined();
    useApp.getState().setBrakes({ allowDiscR: true });
    const z2 = sizeBrakes(st(), { front: 0.8, rear: 1.5 })!;
    // Within the drums' reach it keeps the drums; far beyond it switches.
    expect(z2.patch.drumR).toBeUndefined();
    const z3 = sizeBrakes(st(), { front: 0.8, rear: 3 })!;
    expect(z3.patch.drumR).toBe(false);
    expect(z3.changes.join(' ')).toMatch(/drums → discs/);
    // Bias from the hydraulics with a balance bar: re-set so the bias stays.
    useApp.getState().setBrakes({ drumR: false, useBias: true, dualMc: true });
    const target = brakesOf(st())!.capacity.bias;
    const zb = sizeBrakes(st(), { front: 1.4, rear: 0.6 })!;
    useApp.getState().setBrakes(zb.patch);
    expect(brakesOf(st())!.capacity.bias).toBeCloseTo(target, 3);
  });

  it('a test run records how much of the brakes the hardest stop used; detailed hydraulics flag a long pedal', () => {
    useApp.getState().setBrakes({ detail: true });
    useApp.getState().setBrakeMoreField('maxPedalTravel', '5');
    const { problem } = buildVehicleProblem(st());
    expect(problem.brakeDetail).toBeTruthy();
    const geoms = Object.fromEntries(Object.entries(problem.designs).map(([r, d]) => [r, d!.geometry]));
    const seg = { distance: 40, v0: 20, v1: 0, path: 'straight' as const, radius: 0, grade: 0, bank: 0 };
    const run = runTest(problem, geoms, [seg], { onFail: 'report', speedLimits: false });
    expect(run.brakeUse!.front).toBeGreaterThan(0);
    expect(run.brakeUse!.pedal!).toBeGreaterThan(5);
    expect(run.segments[0]!.findings.some((f) => f.check === 'longPedal')).toBe(true);
    expect(hardestUse([run, { brakeUse: { front: 9, rear: 0 } }])!.front).toBe(9);
  });

  it('saves with the project; format 38 files load with discs and the simple hydraulics', () => {
    const d = defaultDesign();
    d.brakes = { ...d.brakes, on: true, drumR: true, detail: true, allowDiscR: true, mcStroke: { text: '28', value: 28 } };
    const back = importProject(JSON.parse(JSON.stringify(serializeProject(d, 'B'))));
    expect(back.warnings).toEqual([]);
    expect(back.design.brakes.drumR).toBe(true);
    expect(back.design.brakes.detail).toBe(true);
    expect(back.design.brakes.allowDiscR).toBe(true);
    expect(back.design.brakes.mcStroke.value).toBe(28);
    const old = JSON.parse(JSON.stringify(serializeProject(defaultDesign(), 'O')));
    old.formatVersion = 38;
    delete old.brakes.more;
    const r = importProject(old);
    expect(r.warnings).toEqual(Array.from({ length: FORMAT_VERSION - 38 }, (_, i) => `Upgraded from file format ${i + 38} to ${i + 39}.`));
    expect(r.design.brakes.drumR).toBe(false);
    expect(r.design.brakes.detail).toBe(false);
  });
});
