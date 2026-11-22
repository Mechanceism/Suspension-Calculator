import { describe, it, expect } from 'vitest';
import { assembleVehicle, runTest, steerForTurn, trackPath, PROFILES, type VehicleProblem, type TireForceModel, type SegmentSpec } from '../src/core';
import { SAMPLE_LAYOUTS, SAMPLE_SPRING } from '../src/examples/sampleLayouts';

const geom = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
const profile = { radius: 260, width: 205, shoulderRadius: 25, rimRadius: 165 };
const gas: TireForceModel = { kind: 'gas', volumeChange: true, volumeFactor: 1, conditions: { setPressure: 83, setAltitude: 0, setTemperature: 20, operatingAltitude: 0, operatingTemperature: 20 } };
const des = { geometry: geom, profile, model: gas, springRate: SAMPLE_SPRING.rate, freeLength: SAMPLE_SPRING.freeLength, unsprungMass: 12 };

const base = (over: Partial<VehicleProblem> = {}): VehicleProblem => ({
  designs: { FL: des }, roots: { FL: 'FL', FR: 'FL', RL: 'FL', RR: 'FL' },
  settings: { FL: { brake: 'outboard', drive: 'none' }, FR: { brake: 'outboard', drive: 'none' }, RL: { brake: 'outboard', drive: 'chassis' }, RR: { brake: 'outboard', drive: 'chassis' } },
  mass: 300, cg: { x: 0, height: 280, z: -0.47 * 1550 }, wheelbase: 1550, brakeBias: 0.6, driveSplit: 0.5, autoPreload: true,
  shared: { front: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } }, rear: { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } } },
  dropLinks: { front: null, rear: null }, droop: 50, bump: 50, cases: { lateralG: 0, brakingG: 0, accelG: 0 }, goals: [], variables: [],
  steering: { steered: { FL: true, FR: true }, rackLimit: 30, cFactor: 75 },
  ...over,
});
const turn = (path: 'left' | 'right', radius: number): SegmentSpec => ({ distance: 20, v0: 5, v1: 5, path, radius, grade: 0, bank: 0 });

describe('steering for a turn', () => {
  const p = base();
  const asm = assembleVehicle(p, { FL: geom })!;

  it('tighter turns need more rack, left and right are opposite', () => {
    const wide = steerForTurn(asm.built, p.roots, p.steering!, p.wheelbase, 'left', 40)!;
    const tight = steerForTurn(asm.built, p.roots, p.steering!, p.wheelbase, 'left', 10)!;
    const right = steerForTurn(asm.built, p.roots, p.steering!, p.wheelbase, 'right', 40)!;
    expect(wide.none).toBe(false);
    expect(Math.abs(tight.rack)).toBeGreaterThan(Math.abs(wide.rack) * 3);
    expect(Math.sign(right.rack)).toBe(-Math.sign(wide.rack));
    expect(right.rack).toBeCloseTo(-wide.rack, 0);
    expect(wide.wheelAngle).toBeCloseTo((Math.atan(1.55 / 40) * 180) / Math.PI, 6);
    expect(steerForTurn(asm.built, p.roots, p.steering!, p.wheelbase, 'straight', 40)).toBeNull();
  });

  it('a turn tighter than the rack allows fails Steering lock; no steered wheels fails too', () => {
    const tightRun = runTest(p, { FL: geom }, [{ ...turn('left', 2), checks: PROFILES.default.checks }], { onFail: 'report' });
    expect(tightRun.segments[0]!.findings.some((f) => f.check === 'steerLimit')).toBe(true);
    expect(tightRun.passed).toBe(false);
    const ok = runTest(p, { FL: geom }, [turn('left', 60)], { onFail: 'report' });
    expect(ok.segments[0]!.findings.some((f) => f.check === 'steerLimit')).toBe(false);
    expect(Math.abs(ok.states[0]!.state.rack!)).toBeGreaterThan(0.1);
    const none = runTest(base({ steering: { steered: {}, rackLimit: 30, cFactor: 75 } }), { FL: geom }, [turn('right', 60)], { onFail: 'report' });
    expect(none.segments[0]!.findings.some((f) => f.check === 'steerLimit')).toBe(true);
  });
});

describe('track path', () => {
  it('a 90° left arc ends R to the side and turned 90°', () => {
    const R = 20;
    const [a, b] = trackPath([{ distance: 10, path: 'straight', radius: 1 }, { distance: (Math.PI / 2) * R, path: 'left', radius: R }]);
    expect(a!.at(-1)!.x).toBeCloseTo(10, 9);
    const end = b!.at(-1)!;
    expect(end.x).toBeCloseTo(10 + R, 6);
    expect(end.y).toBeCloseTo(R, 6);
    expect(end.heading).toBeCloseTo(Math.PI / 2, 9);
  });
});

describe('full lock from a measured wheel angle', () => {
  it('finds the rack travel that gives the measured angle; inside turns more than outside (Ackermann)', async () => {
    const { rackForWheelAngle, wheelSteerAngle, DoubleWishbone } = await import('../src/core');
    const corner = new DoubleWishbone(geom);
    const span = rackForWheelAngle(corner, (60 * Math.PI) / 180, 'span')!;
    expect(((span.inside + span.outside) * 180) / Math.PI).toBeCloseTo(60, 3);
    const inside = rackForWheelAngle(corner, (35 * Math.PI) / 180, 'inside')!;
    expect((inside.inside * 180) / Math.PI).toBeCloseTo(35, 3);
    expect(Math.abs(wheelSteerAngle(corner, inside.rack)) + Math.abs(wheelSteerAngle(corner, -inside.rack))).toBeGreaterThan(0);
    expect(rackForWheelAngle(corner, 3, 'inside')).toBeNull(); // 172°: out of reach
  });
});

describe('steering mechanisms', () => {
  it('a steering arm swings the inner joint on a circle; loads match virtual work for arm and rack', async () => {
    const { DoubleWishbone, steeringLoads, headingAngle, characteristics, vec3, sub, dot, cross, length, normalize } = await import('../src/core');
    const g0 = SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry;
    // ATV-style plate on a steering column near the centerline, slightly tilted back.
    const pivot1 = vec3(0, 40, -150), pivot2 = vec3(0, 300, -100);
    const arm = { ...g0, steering: { kind: 'arm' as const, pivot1, pivot2 } };
    const c = new DoubleWishbone(arm);
    const axis = normalize(sub(pivot2, pivot1));
    const r0 = length(cross(sub(c.solve({}).points.trInner, pivot1), axis));
    const s10 = c.solve({ rack: 10 });
    expect(s10.solve.status).toBe('converged');
    expect(length(cross(sub(s10.points.trInner, pivot1), axis))).toBeCloseTo(r0, 6);
    const h0 = headingAngle(c.solve({}).spinAxis);
    expect(Math.abs(headingAngle(s10.spinAxis) - h0)).toBeGreaterThan(0.01);
    // Virtual work: |input-side load| ≈ |torque about the steering axis| × |d(steer)/d(input)|.
    const forces = { vertical: 2000, lateral: 0, longitudinal: -800, pneumaticTrail: 0 };
    const check = (geo: typeof g0, mech: Parameters<typeof steeringLoads>[3], perUnit: number) => {
      const k = new DoubleWishbone(geo);
      const s = k.solve({});
      const l = steeringLoads(s, characteristics(s).contactPoint, forces, mech, 75);
      const dh = (headingAngle(k.solve({ rack: 0.05 }).spinAxis) - headingAngle(k.solve({ rack: -0.05 }).spinAxis)) / 0.1; // rad per input unit
      const input = 'kind' in mech && mech.kind === 'arm' ? Math.abs(l.armTorque!) * 1000 : Math.abs(l.rackForce);
      return { input: input * perUnit, expect: Math.abs(l.axisTorque * dh) };
    };
    const a = check(arm, { kind: 'arm', pivot: pivot1, axis }, Math.PI / 180); // N·mm per degree of arm
    expect(a.input / a.expect).toBeCloseTo(1, 1);
    const r = check(g0, vec3(1, 0, 0), 1);
    expect(r.input / r.expect).toBeCloseTo(1, 1);
    void dot;
  });

  it('variable ratio: the steering-wheel angle and the input round-trip; quicker toward lock', async () => {
    const { steeringWheelAngle, inputForWheelAngle, inputPerRev } = await import('../src/core');
    const s = { cFactor: 60, cFactorLock: 90, rackLimit: 30 };
    for (const r of [-30, -12, 0, 5, 30]) expect(inputForWheelAngle(steeringWheelAngle(r, s), s)).toBeCloseTo(r, 9);
    expect(inputPerRev(30, s)).toBe(90);
    // Fewer steering-wheel degrees to full lock than at the center ratio.
    expect(steeringWheelAngle(30, s)).toBeLessThan((30 / 60) * 360);
    expect(steeringWheelAngle(30, { cFactor: 60, rackLimit: 30 })).toBeCloseTo(180, 9);
  });
});

describe('each steering mechanism keeps its own values', () => {
  it('switching rack ↔ arm puts each one\'s ratio and limit back; saved with the project', async () => {
    const { useApp } = await import('../src/app/store');
    const { serializeProject, importProject } = await import('../src/app/project');
    const s = () => useApp.getState();
    s().setSteerField('cFactor', '50');
    s().setSteerField('rackLimit', '35');
    s().setSteerMechanism('arm');
    expect(s().steer.cFactor.value).toBe(360); // first time: typical arm values
    s().setSteerField('cFactor', '20');
    s().setSteerField('cFactorLock', '28');
    s().setSteerMechanism('rack');
    expect(s().steer.cFactor.value).toBe(50);
    expect(s().steer.rackLimit.value).toBe(35);
    expect(s().steer.cFactorLock.value).toBe(0);
    s().setSteerMechanism('arm');
    expect(s().steer.cFactor.value).toBe(20);
    expect(s().steer.cFactorLock.value).toBe(28);
    // The rack's values travel with the project while the arm is in use.
    const back = importProject(JSON.parse(JSON.stringify(serializeProject(s() as never, 'S'))));
    expect(back.design.steerSaved.rack?.cFactor.value).toBe(50);
    expect(back.design.steer.cFactor.value).toBe(20);
    s().setSteerMechanism('rack');
  });
});
